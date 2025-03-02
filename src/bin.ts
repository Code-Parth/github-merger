#!/usr/bin/env node

import { main } from "./index.js";

// Use try-catch to handle any startup errors gracefully
try {
    main().catch(error => {
        console.error("Application failed:", error);
        process.exit(1);
    });
} catch (error) {
    console.error("Failed to start application:", error);
    process.exit(1);
}