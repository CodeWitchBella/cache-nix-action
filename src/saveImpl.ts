import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { Events, Inputs, State } from "./constants";
import { type IStateProvider } from "./stateProvider";
import * as utils from "./utils/actionUtils";

// Catch and log any unhandled exceptions.  These exceptions can leak out of the uploadChunk method in
// @actions/toolkit when a failed upload closes the file descriptor causing any in-process reads to
// throw an uncaught exception.  Instead of failing this action, just warn.
process.on("uncaughtException", e => utils.logWarning(e.message));

async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
    let cacheId = -1;
    try {
        if (!utils.isCacheFeatureAvailable()) {
            return;
        }

        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        // If restore has stored a primary key in state, reuse that
        // Else re-evaluate from inputs
        const primaryKey =
            stateProvider.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);

        if (!primaryKey) {
            utils.logWarning("Key is not specified.");
            return;
        }

        // If matched restore key is same as primary key, then do not save cache
        // NO-OP in case of SaveOnly action
        const restoredKey = stateProvider.getCacheState();

        if (utils.isExactKeyMatch(primaryKey, restoredKey)) {
            core.info(
                `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
            );
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: false
        });

        const nixCache = utils.mkNixCachePath();
        const nixCacheDump = utils.mkDumpPath(nixCache);
        cachePaths.push(nixCacheDump);

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        // == BEGIN Nix Save

        try {
            await utils.logBlock(
                `Creating the ${nixCacheDump} directory if missing.`,
                async () => {
                    await utils.bash(`mkdir -p ${nixCacheDump}`);
                }
            );

            const maxDepth = 100;
            const startTimeFile = utils.mkTimePath(nixCache);

            const nixCacheWorkingSet = utils.getFullInputAsBool(
                Inputs.NixLinuxCacheWorkingSet,
                Inputs.NixMacosCacheWorkingSet
            );

            if (nixCacheWorkingSet) {
                await utils.logBlock(
                    `Reading "${startTimeFile}" access time`,
                    async () => {
                        await utils.bash(
                            `${utils.find_} ${startTimeFile} -printf "%A@ %p"`
                        );
                    }
                );
            }

            const workingSet = `${nixCache}/working-set`;

            if (nixCacheWorkingSet) {
                await utils.logBlock(
                    `Recording ${nixCacheDump}/nix/store files accessed after accessing "${startTimeFile}".`,
                    async () => {
                        await utils.bash(
                            `${utils.findPaths(
                                true,
                                startTimeFile,
                                maxDepth,
                                nixCacheDump
                            )} > ${workingSet}`
                        );
                    }
                );
            }

            const nixDebugEnabled = utils.getFullInputAsBool(
                Inputs.NixLinuxDebugEnabled,
                Inputs.NixMacosDebugEnabled
            );

            if (nixDebugEnabled && nixCacheWorkingSet) {
                await utils.logBlockDebug(
                    `Printing paths categorized w.r.t. ${startTimeFile}`,
                    async () => {
                        await utils.printPathsAll(startTimeFile, maxDepth);
                    }
                );
            }

            const workingSetTmp = `${workingSet}-tmp`;

            if (nixCacheWorkingSet) {
                await utils.logBlock(
                    'Recording top store paths of accessed files. For "/nix/store/top/path", the top store path is "/nix/store/top".',
                    async () => {
                        await utils.bash(
                            `
                            cat ${workingSet} \\
                                | ${utils.awk_} '{ print $2 }' \\
                                | ${utils.awk_} -F "/" '{ printf "/%s/%s/%s\\n", $7, $8, $9 }' \\
                                | ${utils.awk_} '{ !seen[$0]++ }; END { for (i in seen) print i }' \\
                                > ${workingSetTmp}

                            cat ${workingSetTmp} > ${workingSet}
                            `
                        );
                    }
                );
            }

            const gcRoots = `${nixCacheDump}/nix/var/nix/gcroots/nix-cache`;

            await utils.logBlock(
                "Adding working set paths to GC roots.",
                async () => {
                    await utils.bash(
                        `
                    set -a
                    mkdir -p ${gcRoots}
                    cat ${workingSet} \\
                        | gxargs -I {} bash -c 'ln -s {} ${gcRoots}/$(basename {})'
                    `
                    );
                }
            );

            await utils.logBlock(`Collecting garbage.`, async () => {
                await utils.bash(`nix store gc`);
            });

            await utils.logBlock(`Removing symlinks.`, async () => {
                await utils.bash(`rm -rf ${gcRoots}`);
            });

            await utils.logBlock("Printing paths to be cached.", async () => {
                await utils.bash(
                    `${utils.find_} ${nixCacheDump}/nix/store -mindepth 1 -maxdepth 1 -exec du -sh {} \\;`
                );
            });
        } catch (error: unknown) {
            core.setFailed(
                `Failed to save Nix cache: ${(error as Error).message}`
            );
        }
        // == END

        cacheId = await cache.saveCache(
            cachePaths,
            primaryKey,
            { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
            enableCrossOsArchive
        );

        if (cacheId != -1) {
            core.info(`Cache saved with key: ${primaryKey}`);
        }
    } catch (error: unknown) {
        utils.logWarning((error as Error).message);
    }
    return cacheId;
}

export default saveImpl;
