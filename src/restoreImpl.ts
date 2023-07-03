import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { Events, Inputs, Outputs, State } from "./constants";
import { IStateProvider } from "./stateProvider";
import * as utils from "./utils/actionUtils";

async function restoreImpl(
    stateProvider: IStateProvider
): Promise<string | undefined> {
    try {
        if (!utils.isCacheFeatureAvailable()) {
            core.setOutput(Outputs.CacheHit, "false");
            return;
        }

        // Validate inputs, this can cause task failure
        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        const primaryKey = core.getInput(Inputs.Key, { required: true });
        stateProvider.setState(State.CachePrimaryKey, primaryKey);

        const restoreKeys = utils.getInputAsArray(Inputs.RestoreKeys);
        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: false
        });
        const nixCache = utils.mkNixCachePath();
        const nixCacheDump = utils.mkDumpPath(nixCache);
        cachePaths.push(nixCacheDump);
        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );
        const failOnCacheMiss = utils.getInputAsBool(Inputs.FailOnCacheMiss);
        const lookupOnly = utils.getInputAsBool(Inputs.LookupOnly);

        const cacheKey = await cache.restoreCache(
            cachePaths,
            primaryKey,
            restoreKeys,
            { lookupOnly: lookupOnly },
            enableCrossOsArchive
        );

        // == BEGIN Nix Restore

        try {

            await utils.logBlock(
                "Copying Nix store paths from a cache.",
                async () => {
                    // TODO check sigs?
                    // https://nixos.org/manual/nix/unstable/command-ref/new-cli/nix3-copy.html#options
                    await utils.logBlock(
                        `Importing nix store paths from "${nixCacheDump}".`,
                        async () => {
                            await utils.bash(
                                `
                                mkdir -p ${nixCacheDump}/nix/store

                                ls ${nixCacheDump}/nix/store \\
                                    | grep '-' \\
                                    | xargs -I {} bash -c 'nix copy --no-check-sigs --from ${nixCacheDump} /nix/store/{}' \\
                                    2> ${nixCache}/logs
                                
                                cat ${nixCache}/logs

                                sudo rm -rf ${nixCacheDump}/*                                
                                `
                            )
                        }
                    )
                }
            );

            const maxDepth = 1000;

            // Record workflow start time
            const startTime = Date.now() / 1000;
            const startTimeFile = utils.mkTimePath(nixCache);

            await utils.logBlock(
                `Recording start time (${startTime}) by creating a file "${startTimeFile}".`,
                async () => {
                    await utils.bash(`touch ${startTimeFile}`);
                }
            );

            await utils.logBlock(
                "Installing cross-platform GNU findutils.",
                async () => {
                    await utils.bash(
                    `
                    nix profile install nixpkgs#findutils 2> ${nixCache}/logs
                    
                    cat ${nixCache}/logs
                    `);
                }
            );

            const debugEnabled = utils.getInputAsBool(Inputs.DebugEnabled, {
                required: false
            }) || false;

            // Print paths with their access time
            if (debugEnabled) {
                const f = async (newer: boolean): Promise<void> => {
                    const comp = newer ? "after" : "before";
                    await utils.logBlock(
                        `Printing paths accessed ${comp} accessing "${startTimeFile}".`,
                        async () => {
                            core.info(
                                "column 1: access time, column 2: store path"
                            );
                            await utils.bash(
                                utils.findPaths(newer, startTimeFile, maxDepth)
                            );
                        }
                    );
                };

                await f(true);
                await f(false);
            }
        } catch (error: unknown) {
            core.setFailed(
                `Failed to restore Nix cache: ${(error as Error).message}`
            );
        }

        // == END

        if (!cacheKey) {
            if (failOnCacheMiss) {
                throw new Error(
                    `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${primaryKey}`
                );
            }
            core.info(
                `Cache not found for input keys: ${[
                    primaryKey,
                    ...restoreKeys
                ].join(", ")}`
            );

            return;
        }

        // Store the matched cache key in states
        stateProvider.setState(State.CacheMatchedKey, cacheKey);

        const isExactKeyMatch = utils.isExactKeyMatch(
            core.getInput(Inputs.Key, { required: true }),
            cacheKey
        );

        core.setOutput(Outputs.CacheHit, isExactKeyMatch.toString());
        if (lookupOnly) {
            core.info(`Cache found and can be restored from key: ${cacheKey}`);
        } else {
            core.info(`Cache restored from key: ${cacheKey}`);
        }

        return cacheKey;
    } catch (error: unknown) {
        core.setFailed((error as Error).message);
    }
}

export default restoreImpl;
