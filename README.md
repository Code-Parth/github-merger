# GitHub Merger

A command-line tool to merge files from a GitHub repository into a single file. Works on Windows, macOS, and Linux.

## Features

- Clone a GitHub repository and merge its files into a single output file
- Interactive branch selection
- Filter by file extensions
- Exclude specified directories and files
- Generate a file tree structure in the output
- Cross-platform temporary file handling

## Installation

### Global Installation

```bash
# Install globally using npm
npm install -g github-merger

# Or using yarn
yarn global add github-merger

# Or using pnpm
pnpm add -g github-merger

# Or using Bun
bun install -g github-merger
```

### Local Development

```bash
# Clone the repository
git clone https://github.com/yourusername/github-merger.git
cd github-merger

# Install dependencies
npm install
# or
bun install

# Run locally
npm start
# or
bun start
```

## Usage

After installing globally, you can run the tool from anywhere:

```bash
github-merger
```

Or if you're working locally:

```bash
npm start
# or
bun start
```

The interactive CLI will guide you through:

1. Entering a GitHub repository URL
2. Selecting a branch
3. Choosing file types to include
4. Specifying the output file path

## Requirements

- Node.js 18.0.0 or higher (or Bun)
- Git must be installed and available in your PATH

## Publishing to NPM

```bash
# Login to npm
npm login

# Publish the package
npm publish
```

## License

MIT
