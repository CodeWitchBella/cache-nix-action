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
                `Using store at "${nixCacheDump}".`,
                async () => {
                    await utils.bash(
                        `
                        mkdir -p ${nixCacheDump}
                        mkdir -p ~/.config/nix
                        printf '\\nstore = ${nixCacheDump}' >> ~/.config/nix/nix.conf
                        printf 'STORE=${nixCacheDump}' >> "$GITHUB_ENV"
                        `
                    );
                }
            );

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

            await utils.logBlock(`Installing tools.`, async () => {
                await utils.bash(
                    `
                    nix copy --from ${nixCacheDump} nixpkgs#coreutils-prefixed nixpkgs#gawk --to ''
                    nix profile install nixpkgs#coreutils-prefixed nixpkgs#gawk --store ''
                    `
                );
            });

            await utils.logBlock(
                `Printing ${nixCacheDump}/nix/store paths.`,
                async () => {
                    await utils.bash(
                        `
                        mkdir -p ${nixCacheDump}/nix/store
                        ${utils.find_} ${nixCacheDump}/nix/store -mindepth 1 -maxdepth 1 -exec du -sh {} \\;
                        `
                    );
                }
            );
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
