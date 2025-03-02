import ora from "ora";
import fs from "fs";
import chalk from "chalk";
import path from "path";
import os from "os";
import inquirer from "inquirer";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import figlet from "figlet";

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

// Function to validate GitHub URL format
function isValidGitHubUrl(url: string): boolean {
    const gitHubUrlPattern = /^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\/(tree|blob)\/[\w.-]+)?$/;
    return gitHubUrlPattern.test(url);
}

// Function to check if a repository exists
async function checkRepositoryExists(url: string): Promise<boolean> {
    try {
        const { stdout, stderr } = await exec(`git ls-remote --quiet --exit-code ${url}`);
        return true;
    } catch (error) {
        return false;
    }
}

async function getAvailableBranches(githubUrl: string, tempDir: string): Promise<string[] | null> {
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

            try {
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
            } catch (error) {
                spinner.fail("Failed to fetch branches from repository");
                return null;
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
        const spinner = ora().fail("Error getting branches");

        // Check if it's a repository not found error
        if (error instanceof Error && error.message.includes("not found")) {
            console.error(chalk.red("Repository not found or access denied"));
            return null;
        }

        console.error(chalk.red("Error details:"), error instanceof Error ? error.message : String(error));
        const defaultBranches = ["main", "master"];

        console.log(chalk.yellow("\nFalling back to common branch names:"));
        defaultBranches.forEach((branch, index) => {
            console.log(`${chalk.gray(`${index + 1}.`)} ${chalk.white(branch)}`);
        });

        return defaultBranches;
    }
}

async function cloneRepository(githubUrl: string, destination: string, branch?: string): Promise<boolean> {
    const spinner = ora(`Cloning repository from ${githubUrl}${branch ? ` (branch: ${branch})` : ""}...`).start();

    try {
        if (branch) {
            await exec(`git clone -b ${branch} ${githubUrl} ${destination}`);
        } else {
            await exec(`git clone ${githubUrl} ${destination}`);
        }

        spinner.succeed("Repository cloned successfully");
        return true;
    } catch (error) {
        spinner.fail("Failed to clone repository");

        // Provide detailed error message
        if (error instanceof Error) {
            if (error.message.includes("not found")) {
                console.error(chalk.red("Repository not found or access denied."));
            } else if (error.message.includes("already exists")) {
                console.error(chalk.red("Destination directory already exists."));
            } else if (error.message.includes("does not exist")) {
                console.error(chalk.red(`Branch "${branch}" does not exist.`));
            } else {
                console.error(chalk.red("Error details:"), error.message);
            }
        } else {
            console.error(chalk.red("Unknown error occurred during cloning."));
        }

        return false;
    }
}

async function mergeRepositoryFiles(
    githubUrl: string,
    options: Options = {}
): Promise<boolean> {
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
        // Clone the repository
        const cloneSuccess = await cloneRepository(githubUrl, tempDir, branch);
        if (!cloneSuccess) {
            return false;
        }

        const fileTree = await buildFileTree(
            tempDir,
            excludeDirs,
            repoName,
            includeExtensions
        );

        // Check if file tree is empty (no files matched the criteria)
        if (!fileTree.children || fileTree.children.length === 0) {
            console.log(chalk.yellow("No files found matching the selected criteria."));
            return false;
        }

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
        return true;
    } catch (error) {
        console.error(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
        return false;
    } finally {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        tempDirectories = tempDirectories.filter(dir => dir !== tempDir);
    }
}

async function promptForGitHubUrl(): Promise<string | null> {
    try {
        const { githubUrl } = await inquirer.prompt([
            {
                type: "input",
                name: "githubUrl",
                message: chalk.blue("Enter GitHub repository URL:"),
                validate: async (input) => {
                    if (input.trim() === "") {
                        return "Repository URL is required";
                    }

                    if (!isValidGitHubUrl(input)) {
                        return "Please enter a valid GitHub repository URL (e.g., https://github.com/username/repo)";
                    }

                    return true;
                }
            }
        ]);

        return githubUrl;
    } catch (error) {
        console.error(chalk.red("Error while prompting for GitHub URL:"), error);
        return null;
    }
}

async function main() {
    try {
        // Display figlet banner
        console.log("\n" + chalk.bold.cyan(
            figlet.textSync("GitHub Merger", {
                font: "Standard",
                horizontalLayout: "default",
                verticalLayout: "default",
                width: 100,
                whitespaceBreak: true
            })
        ));

        console.log("\n" + chalk.bold.cyan("📁 Repository File Merger Tool 📁"));
        console.log(chalk.dim("Press Ctrl+C at any time to exit safely.\n"));

        // Loop until we get a valid GitHub URL and successfully process it
        let processingComplete = false;

        while (!processingComplete) {
            const githubUrl = await promptForGitHubUrl();

            if (!githubUrl) {
                console.error(chalk.red("Failed to get GitHub URL. Exiting..."));
                return;
            }

            // Verify repository exists before proceeding
            const repoCheckSpinner = ora("Checking repository...").start();
            const repoExists = await checkRepositoryExists(githubUrl);

            if (!repoExists) {
                repoCheckSpinner.fail("Repository not found or not accessible");
                console.log(chalk.yellow("Please check the URL and your internet connection and try again."));

                const { retry } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "retry",
                        message: "Would you like to try another repository?",
                        default: true
                    }
                ]);

                if (!retry) {
                    console.log(chalk.yellow("Exiting..."));
                    return;
                }

                continue; // Loop back to prompt for a new URL
            }

            repoCheckSpinner.succeed("Repository found");

            const repoName = getRepoNameFromUrl(githubUrl);
            const tempBranchDir = path.join(TEMP_BASE_DIR, `branch-${Date.now().toString(36)}`);
            tempDirectories.push(tempBranchDir);

            try {
                // Get available branches
                const branches = await getAvailableBranches(githubUrl, tempBranchDir);

                if (!branches) {
                    console.log(chalk.yellow("Failed to fetch branches"));

                    const { retry } = await inquirer.prompt([
                        {
                            type: "confirm",
                            name: "retry",
                            message: "Would you like to try another repository?",
                            default: true
                        }
                    ]);

                    if (!retry) {
                        console.log(chalk.yellow("Exiting..."));
                        return;
                    }

                    continue; // Loop back to prompt for a new URL
                }

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
                    // Clone repo for scanning
                    const scanCloneSuccess = await cloneRepository(
                        githubUrl,
                        tempScanDir,
                        selectedBranch ? selectedBranch : undefined
                    );

                    if (!scanCloneSuccess) {
                        const { retry } = await inquirer.prompt([
                            {
                                type: "confirm",
                                name: "retry",
                                message: "Would you like to try another repository?",
                                default: true
                            }
                        ]);

                        if (!retry) {
                            console.log(chalk.yellow("Exiting..."));
                            return;
                        }

                        continue; // Loop back to prompt for a new URL
                    }

                    // Scan for file extensions
                    const scanSpinner = ora("Scanning repository for file types...").start();
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
                    const mergeSuccess = await mergeRepositoryFiles(githubUrl, {
                        branch: selectedBranch,
                        includeExtensions: selectedExtensions,
                        outputPath: outputPath || defaultOutput
                    });

                    if (mergeSuccess) {
                        console.log("\n" + chalk.bold.green("✅ File merge completed successfully!"));
                        processingComplete = true;
                    } else {
                        console.log(chalk.yellow("File merge was not successful."));

                        const { retry } = await inquirer.prompt([
                            {
                                type: "confirm",
                                name: "retry",
                                message: "Would you like to try another repository?",
                                default: true
                            }
                        ]);

                        if (!retry) {
                            console.log(chalk.yellow("Exiting..."));
                            return;
                        }
                    }
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
        }
    } catch (error) {
        console.error(chalk.red("Unexpected error:"), error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.stack) {
            console.error(chalk.dim(error.stack));
        }
    } finally {
        cleanup();
    }
}

export { main, mergeRepositoryFiles, cleanup };
