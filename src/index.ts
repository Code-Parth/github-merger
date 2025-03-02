#!/usr/bin/env node

import ora from "ora";
import fs from "fs";
import chalk from "chalk";
import path from "path";
import os from "os";
import inquirer from "inquirer";
import { exec as execCallback } from "child_process";
import { promisify } from "util";

const exec = promisify(execCallback);

// Use system's temp directory
const TEMP_BASE_DIR = path.join(os.tmpdir(), "github-merger");

// Ensure the base temp directory exists
if (!fs.existsSync(TEMP_BASE_DIR)) {
    fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });
}

let tempDirectories: string[] = [];

process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\nGracefully shutting down..."));
    cleanup();
    process.exit(0);
});

function cleanup() {
    console.log(chalk.dim("Cleaning up temporary files..."));
    for (const dir of tempDirectories) {
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (error) {
                // Silently ignore errors during cleanup
            }
        }
    }
}

interface Options {
    excludeDirs?: string[];
    excludeFiles?: string[];
    outputPath?: string;
    includeExtensions?: string[];
    branch?: string;
}

interface FileTree {
    name: string;
    type: "file" | "directory";
    children?: FileTree[];
}

function getRepoNameFromUrl(url: string): string {
    const match = url.match(/\/([^\/]+?)(\.git)?$/);
    return match ? match[1] : "repository";
}

function generateTreeString(
    structure: FileTree,
    prefix = "",
    isLast = true
): string {
    const marker = isLast ? "└─ " : "├─ ";
    let tree = prefix + marker + structure.name + "\n";

    if (structure.children) {
        const childPrefix = prefix + (isLast ? "   " : "│  ");
        structure.children.forEach((child, index) => {
            tree += generateTreeString(
                child,
                childPrefix,
                index === structure.children!.length - 1
            );
        });
    }

    return tree;
}

async function buildFileTree(
    directory: string,
    excludeDirs: string[],
    repoName: string,
    includeExtensions?: string[]
): Promise<FileTree> {
    const structure: FileTree = {
        name: repoName,
        type: "directory",
        children: [],
    };

    const items = fs.readdirSync(directory);
    const sortedItems = items.sort((a, b) => {
        const aIsDir = fs.statSync(path.join(directory, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(directory, b)).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
    });

    for (const item of sortedItems) {
        const fullPath = path.join(directory, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!excludeDirs.includes(item)) {
                const childTree = await buildFileTree(
                    fullPath,
                    excludeDirs,
                    item,
                    includeExtensions
                );
                // Only add directories that have children (after filtering)
                if (childTree.children && childTree.children.length > 0) {
                    structure.children!.push(childTree);
                }
            }
        } else {
            const ext = path.extname(item).toLowerCase();
            if (
                !includeExtensions ||
                includeExtensions.map((e) => e.toLowerCase()).includes(ext)
            ) {
                structure.children!.push({
                    name: item,
                    type: "file",
                });
            }
        }
    }

    return structure;
}

async function getAvailableFileExtensions(directory: string, excludeDirs: string[]): Promise<string[]> {
    const extensions = new Set<string>();

    function scanDirectorySync(dir: string) {
        try {
            const files = fs.readdirSync(dir);

            for (const file of files) {
                try {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);

                    if (stat.isDirectory()) {
                        if (!excludeDirs.includes(file)) {
                            scanDirectorySync(fullPath);
                        }
                    } else {
                        const ext = path.extname(file).toLowerCase();
                        if (ext) {
                            extensions.add(ext);
                        }
                    }
                } catch (err) {
                    // Skip any files that can't be accessed
                    continue;
                }
            }
        } catch (err) {
            // Skip any directories that can't be accessed
            return;
        }
    }

    scanDirectorySync(directory);

    return Array.from(extensions).sort();
}

async function getAvailableBranches(githubUrl: string, tempDir: string): Promise<string[]> {
    try {
        const spinner = ora("Fetching repository branches...").start();

        const { stdout } = await exec(`git ls-remote --heads ${githubUrl}`);

        const branches = stdout
            .split("\n")
            .filter(line => line.trim() !== "")
            .map(line => {
                const match = line.match(/refs\/heads\/(.+)$/);
                return match ? match[1] : null;
            })
            .filter((branch): branch is string => branch !== null)
            .sort();

        spinner.succeed("Branches fetched successfully");

        if (branches.length === 0) {
            spinner.warn("No branches found via ls-remote, trying fallback method...");

            // Fallback method: try to clone with --bare and use git branch
            await exec(`git clone --bare ${githubUrl} ${tempDir}`);
            const { stdout: branchOutput } = await exec(`cd ${tempDir} && git branch -r`);

            const fallbackBranches = branchOutput
                .split("\n")
                .filter(line => line.trim() !== "")
                .map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("origin/") && !trimmed.includes("->")) {
                        return trimmed.replace("origin/", "");
                    }
                    return null;
                })
                .filter((branch): branch is string => branch !== null && branch !== "HEAD")
                .sort();

            if (fallbackBranches.length > 0) {
                spinner.succeed("Branches found with fallback method");

                console.log(chalk.blue("\nAvailable branches:"));
                fallbackBranches.forEach((branch, index) => {
                    console.log(`${chalk.gray(`${index + 1}.`)} ${chalk.white(branch)}`);
                });

                return fallbackBranches;
            }

            spinner.warn("No branches found with fallback method, using defaults");
            const defaultBranches = ["main", "master"];

            console.log(chalk.yellow("\nUsing default branches:"));
            defaultBranches.forEach((branch, index) => {
                console.log(`${chalk.gray(`${index + 1}.`)} ${chalk.white(branch)}`);
            });

            return defaultBranches;
        }

        console.log(chalk.blue("\nAvailable branches:"));
        branches.forEach((branch, index) => {
            console.log(`${chalk.gray(`${index + 1}.`)} ${chalk.white(branch)}`);
        });

        return branches;
    } catch (error) {
        console.error(chalk.red("Error getting branches:"), error);
        const defaultBranches = ["main", "master"];

        console.log(chalk.yellow("\nFalling back to common branch names:"));
        defaultBranches.forEach((branch, index) => {
            console.log(`${chalk.gray(`${index + 1}.`)} ${chalk.white(branch)}`);
        });

        return defaultBranches;
    }
}

async function mergeRepositoryFiles(
    githubUrl: string,
    options: Options = {}
): Promise<void> {
    const {
        excludeDirs = ["node_modules", ".git", "dist", "build", ".github", ".vscode"],
        excludeFiles = [".env", ".gitignore", "package-lock.json", "yarn.lock", ".DS_Store"],
        outputPath = "merged-output.txt",
        includeExtensions,
        branch
    } = options;

    // Create a unique temp directory within the system temp directory
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substring(2);
    const tempDir = path.join(TEMP_BASE_DIR, `repo-${uniqueId}`);
    
    // Add to tracked temp directories
    tempDirectories.push(tempDir);

    const repoName = getRepoNameFromUrl(githubUrl);

    try {
        const spinner = ora(`Cloning repository from ${githubUrl}${branch ? ` (branch: ${branch})` : ""}...`).start();

        if (branch) {
            await exec(`git clone -b ${branch} ${githubUrl} ${tempDir}`);
        } else {
            await exec(`git clone ${githubUrl} ${tempDir}`);
        }

        spinner.succeed("Repository cloned successfully");

        const fileTree = await buildFileTree(
            tempDir,
            excludeDirs,
            repoName,
            includeExtensions
        );
        const treeString =
            repoName +
            "/\n" +
            generateTreeString(fileTree, "", true).split("\n").slice(2).join("\n");

        let mergedContent = `// Source: ${githubUrl}${branch ? ` (branch: ${branch})` : ""}\n`;
        mergedContent += `// Merged on: ${new Date().toISOString()}\n\n`;
        mergedContent += "/*\n";
        mergedContent += treeString;
        mergedContent += "*/\n\n";

        const mergeSpinner = ora("Merging files...").start();

        async function processDirectory(directory: string): Promise<void> {
            const items = fs.readdirSync(directory);

            for (const item of items) {
                const fullPath = path.join(directory, item);
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    if (!excludeDirs.includes(item)) {
                        await processDirectory(fullPath);
                    }
                } else {
                    const ext = path.extname(item).toLowerCase();
                    if (
                        !excludeFiles.includes(item) &&
                        (!includeExtensions ||
                            includeExtensions.map((e) => e.toLowerCase()).includes(ext))
                    ) {
                        const content = fs.readFileSync(fullPath, "utf8");
                        mergedContent += `\n// File: ${fullPath.replace(
                            tempDir + path.sep,
                            repoName + "/"
                        )}\n`;
                        mergedContent += `${content}\n`;
                    }
                }
            }
        }

        await processDirectory(tempDir);
        fs.writeFileSync(outputPath, mergedContent);
        mergeSpinner.succeed(`Successfully merged files into ${chalk.green(outputPath)}`);
    } catch (error) {
        console.error(chalk.red("Error:"), error);
        throw error;
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDirectories = tempDirectories.filter(dir => dir !== tempDir);
    }
}

async function main() {
    try {
        console.log("\n" + chalk.bold.cyan("📁 GitHub Repository File Merger 📁") + "\n");
        console.log(chalk.dim("Press Ctrl+C at any time to exit safely.\n"));

        const { githubUrl } = await inquirer.prompt([
            {
                type: "input",
                name: "githubUrl",
                message: chalk.blue("Enter GitHub repository URL:"),
                validate: (input) => input.trim() !== "" || "Repository URL is required"
            }
        ]);

        if (!githubUrl) {
            console.error(chalk.red("Repository URL is required"));
            process.exit(1);
        }

        const repoName = getRepoNameFromUrl(githubUrl);
        const tempBranchDir = path.join(TEMP_BASE_DIR, `branch-${Date.now().toString(36)}`);
        tempDirectories.push(tempBranchDir);

        try {
            const branches = await getAvailableBranches(githubUrl, tempBranchDir);

            if (branches.length === 0) {
                console.log(chalk.yellow("No branches found, using default branch"));
                branches.push("main");
            }

            const branchChoices = [
                { name: chalk.italic("Default branch"), value: null },
                ...branches.map((branch) => ({
                    name: `${chalk.white(branch)}`,
                    value: branch
                }))
            ];

            const { selectedBranch } = await inquirer.prompt([
                {
                    type: "list",
                    name: "selectedBranch",
                    message: chalk.blue("Select a branch:"),
                    choices: branchChoices,
                    pageSize: 10,
                    loop: false
                }
            ]);

            if (selectedBranch) {
                console.log(`Selected branch: ${chalk.green(selectedBranch)}`);
            } else {
                console.log(chalk.yellow("Using default branch"));
            }

            const tempScanDir = path.join(TEMP_BASE_DIR, `scan-${Date.now().toString(36)}`);
            tempDirectories.push(tempScanDir);

            try {
                const scanSpinner = ora("Scanning repository for file types...").start();

                if (selectedBranch) {
                    await exec(`git clone -b ${selectedBranch} --depth=1 ${githubUrl} ${tempScanDir}`);
                } else {
                    await exec(`git clone --depth=1 ${githubUrl} ${tempScanDir}`);
                }

                const excludeDirs = ["node_modules", ".git", "dist", "build"];
                const availableExtensions = await getAvailableFileExtensions(tempScanDir, excludeDirs);

                scanSpinner.succeed(`Found ${availableExtensions.length} file types in repository`);

                let selectedExtensions: string[] = [];

                if (availableExtensions.length > 0) {
                    const promptOptions = [];

                    promptOptions.push({
                        name: "Select all file types",
                        value: "*ALL*"
                    });

                    for (const ext of availableExtensions) {
                        promptOptions.push({
                            name: ext,
                            value: ext
                        });
                    }

                    const { fileSelection } = await inquirer.prompt([
                        {
                            type: "checkbox",
                            name: "fileSelection",
                            message: chalk.blue(`Select file types to include (${availableExtensions.length} available):`),
                            choices: promptOptions,
                            pageSize: Math.min(25, availableExtensions.length + 1),
                            loop: true
                        }
                    ]);

                    if (fileSelection.includes("*ALL*")) {
                        selectedExtensions = [...availableExtensions];
                        console.log(chalk.green("Selected all file types"));
                    } else if (fileSelection.length > 0) {
                        selectedExtensions = fileSelection;
                        console.log(`Selected file types: ${chalk.green(selectedExtensions.join(", "))}`);
                    } else {
                        selectedExtensions = [...availableExtensions];
                        console.log(chalk.yellow("No file types selected, using all file types"));
                    }
                } else {
                    console.log(chalk.yellow("No file types found in repository"));
                    selectedExtensions = [];
                }

                if (selectedExtensions && selectedExtensions.length > 0) {
                    console.log(`Selected file types: ${chalk.green(selectedExtensions.join(", "))}`);
                } else {
                    console.log(chalk.yellow("Including all file types"));
                }

                const defaultOutput = `${repoName}.txt`;

                const { outputPath } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "outputPath",
                        message: chalk.blue("Enter output file path:"),
                        default: defaultOutput
                    }
                ]);

                console.log("\n" + chalk.cyan("Starting file merge process..."));
                await mergeRepositoryFiles(githubUrl, {
                    branch: selectedBranch,
                    includeExtensions: selectedExtensions,
                    outputPath: outputPath || defaultOutput
                });

                console.log("\n" + chalk.bold.green("✅ File merge completed successfully!"));
            } finally {
                if (fs.existsSync(tempScanDir)) {
                    fs.rmSync(tempScanDir, { recursive: true, force: true });
                }
                tempDirectories = tempDirectories.filter(dir => dir !== tempScanDir);
            }
        } finally {
            if (fs.existsSync(tempBranchDir)) {
                fs.rmSync(tempBranchDir, { recursive: true, force: true });
            }
            tempDirectories = tempDirectories.filter(dir => dir !== tempBranchDir);
        }
    } catch (error) {
        console.error(chalk.red("Error:"), error);
    } finally {
        cleanup();
    }
}

// Run the main function if this file is being executed directly
if (import.meta.url.endsWith(process.argv[1])) {
    main().catch(error => {
        console.error(chalk.red("Application failed:"), error);
        cleanup();
        process.exit(1);
    });
}

export { main, mergeRepositoryFiles };
