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
            // TODO check sigs?
            // https://nixos.org/manual/nix/unstable/command-ref/new-cli/nix3-copy.html#options
            const nixKeepCache = utils.getFullInputAsBool(
                Inputs.NixLinuxKeepCache,
                Inputs.NixMacosKeepCache
            );

            const nixDebugEnabled = utils.getFullInputAsBool(
                Inputs.NixLinuxDebugEnabled,
                Inputs.NixMacosDebugEnabled
            );

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
                        `
                    );

                    if (nixDebugEnabled) {
                        await utils.bash(`cat ${nixCache}/logs`);
                    }
                }
            );

            if (!nixKeepCache) {
                await utils.logBlock(`Removing ${nixCacheDump}`, async () => {
                    await utils.bash(`sudo rm -rf ${nixCacheDump}/*`);
                });
            }

            const maxDepth = utils.maxDepth;

            // Record workflow start time
            const startTime = Date.now() / 1000;
            const startTimeFile = utils.mkTimePath(nixCache);

            const nixCacheWorkingSet = utils.getFullInputAsBool(
                Inputs.NixLinuxCacheWorkingSet,
                Inputs.NixMacosCacheWorkingSet
            );

            if (nixCacheWorkingSet) {
                await utils.logBlock(
                    `Recording time (${startTime}) by creating a file "${startTimeFile}".`,
                    async () => {
                        await utils.bash(`touch ${startTimeFile}`);
                    }
                );
            }

            await utils.logBlock(
                "Installing cross-platform GNU findutils.",
                async () => {
                    await utils.bash(
                        `nix profile install nixpkgs#findutils 2> ${nixCache}/logs`
                    );
                }
            );

            if (nixDebugEnabled) {
                await utils.bash(`cat ${nixCache}/logs`);
            }

            await utils.logBlock("Listing /nix/store/ paths.", async () => {
                await utils.bash(
                    `find /nix/store -mindepth 1 -maxdepth 1 -exec du -sh {} \\;`
                );
            });

            if (nixDebugEnabled) {
                utils.printPathsAll(startTimeFile, maxDepth);
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
