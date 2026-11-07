#!/usr/bin/env node
// The dd2dash0 executable. With no arguments in an interactive terminal it opens the app (a menu over every command);
// with arguments it is the plain CLI, so scripts and CI behave exactly as before.
import { main } from "./cli.js";

const argv = process.argv.slice(2);
const interactive = argv.length === 0 || argv[0] === "app";
const code =
  interactive && process.stdin.isTTY && process.stdout.isTTY
    ? await (await import("./app.js")).startApp(main)
    : await Promise.resolve(main(argv[0] === "app" ? [] : argv));
process.exit(code);
