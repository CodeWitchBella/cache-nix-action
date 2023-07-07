import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";
import { dedent } from "ts-dedent";

import { RefKey } from "../constants";

export function isGhes(): boolean {
    const ghUrl = new URL(
        process.env["GITHUB_SERVER_URL"] || "https://github.com"
    );
    return ghUrl.hostname.toUpperCase() !== "GITHUB.COM";
}

export function isExactKeyMatch(key: string, cacheKey?: string): boolean {
    return !!(
        cacheKey &&
        cacheKey.localeCompare(key, undefined, {
            sensitivity: "accent"
        }) === 0
    );
}

export function logWarning(message: string): void {
    const warningPrefix = "[warning]";
    core.info(`${warningPrefix}${message}`);
}

// Cache token authorized for all events that are tied to a ref
// See GitHub Context https://help.github.com/actions/automating-your-workflow-with-github-actions/contexts-and-expression-syntax-for-github-actions#github-context
export function isValidEvent(): boolean {
    return RefKey in process.env && Boolean(process.env[RefKey]);
}

export enum FGColor {
    FgBlack = "\x1b[30m",
    FgRed = "\x1b[31m",
    FgGreen = "\x1b[32m",
    FgYellow = "\x1b[33m",
    FgBlue = "\x1b[34m",
    FgMagenta = "\x1b[35m",
    FgCyan = "\x1b[36m",
    FgWhite = "\x1b[37m",
    FgGray = "\x1b[90m"
}

export const OutputColor = {
    Debug: FGColor.FgMagenta,
    Info: FGColor.FgBlue,
    Error: FGColor.FgRed
};

export async function bash(command: string): Promise<void> {
    const command_ = dedent(command.trim());

    command_.split("\n").map(val => {
        console.log(FGColor.FgCyan, val);
    });

    const result = await getExecOutput("bash", ["-c", command], {
        silent: true
    });
    if (result.stderr.length > 0) {
        core.error(result.stderr);
    }
    core.info(result.stdout);
}

export function getInputAsArray(
    name: string,
    options?: core.InputOptions
): string[] {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.replace(/^!\s+/, "!").trim())
        .filter(x => x !== "");
}

export function getInputAsInt(
    name: string,
    options?: core.InputOptions
): number | undefined {
    const value = parseInt(core.getInput(name, options));
    if (isNaN(value) || value < 0) {
        return undefined;
    }
    return value;
}

export function getInputAsBool(
    name: string,
    options?: core.InputOptions
): boolean {
    const result = core.getInput(name, options);
    return result.toLowerCase() === "true";
}

export function getFullInputAsBool(
    inputLinux: string,
    inputMacos: string
): boolean {
    return (
        (process.platform == "linux" &&
            getInputAsBool(inputLinux, {
                required: false
            })) ||
        (process.platform == "darwin" &&
            getInputAsBool(inputMacos, {
                required: false
            }))
    );
}

export function isCacheFeatureAvailable(): boolean {
    if (cache.isFeatureAvailable()) {
        return true;
    }

    if (isGhes()) {
        logWarning(
            `Cache action is only supported on GHES version >= 3.5. If you are on version >=3.5 Please check with GHES admin if Actions cache service is enabled or not.
Otherwise please upgrade to GHES version >= 3.5 and If you are also using Github Connect, please unretire the actions/cache namespace before upgrade (see https://docs.github.com/en/enterprise-server@3.5/admin/github-actions/managing-access-to-actions-from-githubcom/enabling-automatic-access-to-githubcom-actions-using-github-connect#automatic-retirement-of-namespaces-for-actions-accessed-on-githubcom)`
        );
        return false;
    }

    logWarning(
        "An internal error has occurred in cache backend. Please check https://www.githubstatus.com/ for any ongoing issue in actions."
    );
    return false;
}

export function mkNixCachePath(): string {
    return `${
        process.platform == "darwin" ? "/Users" : "/home"
    }/runner/work/nix-cache`;
}

export function mkDumpPath(path: string): string {
    return `${path}/dump`;
}

export function mkTimePath(path: string, suffix = ""): string {
    return `${path}/time${suffix}`;
}

export function framedNewlines(message: string): string {
    return `\n\n${message}\n\n`;
}

export function logMessage(message: string, prefix = "", color: FGColor): void {
    framedNewlines(`${prefix.length > 0 ? prefix + " " : ""}${message}`)
        .split("\n")
        .map(line => {
            console.log(color, line);
        });
}

export function startMessage(message: string): string {
    return `[START] ${message}`;
}

export function finishMessage(message: string): string {
    return `[FINISH] ${message}`;
}

export function logStart(message: string, color = OutputColor.Info): void {
    logMessage(startMessage(message), "", color);
}

export function logFinish(message: string, color = OutputColor.Info): void {
    logMessage(finishMessage(message), "", color);
}

export async function logBlock(
    message: string,
    actions: () => Promise<void>,
    color = OutputColor.Info
): Promise<void> {
    logStart(message, color);
    await actions();
    logFinish(message, color);
}

export async function logBlockDebug(
    message = "Debug",
    actions: () => Promise<void>
): Promise<void> {
    await logBlock(message, actions, OutputColor.Debug);
}

export function findPaths(
    newer: boolean,
    startTimeFile: string,
    maxDepth: number,
    root = ""
): string {
    const op = newer ? "" : "\\!";
    return `${find_} ${root}/nix/store -mindepth 1 -maxdepth ${maxDepth} -path '*-*' ${op} -neweraa ${startTimeFile} -printf "%A@ %p\\n"`;
}

export async function printPaths(
    newer: boolean,
    startTimeFile: string,
    maxDepth: number
): Promise<void> {
    const comp = newer ? "after" : "before";
    await logBlock(
        `Printing paths accessed ${comp} accessing ${startTimeFile}`,
        async () => {
            core.info("column 1: access time, column 2: store path");
            await bash(findPaths(newer, startTimeFile, maxDepth));
        }
    );
}

export async function printPathsAll(
    startTimeFile: string,
    maxDepth: number
): Promise<void> {
    await printPaths(false, startTimeFile, maxDepth);
    await printPaths(true, startTimeFile, maxDepth);
}

export const maxDepth = 1000;

export const find_ = `nix shell nixpkgs#findutils -c find`;
export const awk_ = `nix shell nixpkgs#gawk -c awk`;
