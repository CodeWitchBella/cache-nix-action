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
            core.info(`Saving nix cache to ${nixCacheDump}...`);

            await utils.logBlock(
                `Creating the ${nixCacheDump} directory`,
                async () => {
                    await utils.bash(`mkdir -p ${nixCacheDump}`);
                }
            );

            const maxDepth = 100;
            const startTimeFile = utils.mkTimePath(nixCache);

            await utils.logBlock(
                `Reading ${startTimeFile} access time`,
                async () => {
                    await utils.bash(`find ${startTimeFile} -printf "%A@ %p"`);
                }
            );

            const workingSet = `${nixCache}/working-set`;

            await utils.logBlock(
                `Recording /nix/store files accessed after accessing "${startTimeFile}".`,
                async () => {
                    await utils.bash(
                        `${utils.findPaths(
                            true,
                            startTimeFile,
                            maxDepth
                        )} > ${workingSet}`
                    );
                }
            );

            const debug =
                utils.getInputAsBool(Inputs.DebugEnabled, {
                    required: false
                }) || false;

            if (debug) {
                await utils.logBlockDebug(
                    `Printing paths categorized w.r.t. ${startTimeFile}`,
                    async () => {
                        await utils.printPathsAll(startTimeFile, maxDepth);
                    }
                );
            }

            const workingSetTmp = `${workingSet}-tmp`;

            await utils.logBlock(
                'Recording top store paths of accessed files. For "/nix/store/top/path", the top store path is "/nix/store/top".',
                async () => {
                    await utils.bash(
                        `
                        cat ${workingSet} \\
                            | awk '{ print $2 }' \\
                            | awk -F "/" '{ printf "/%s/%s/%s\\n", $2, $3, $4 }' \\
                            | awk '{ !seen[$0]++ }; END { for (i in seen) print i }' \\
                            | awk '!/.drv$/ { print }' \\
                            > ${workingSetTmp}
    
                        cat ${workingSetTmp} > ${workingSet}
                        `
                    );
                }
            );

            await utils.logBlockDebug(
                "Printing top store paths to be cached",
                async () => {
                    await utils.bash(`cat ${workingSet}`);
                }
            );

            await utils.logBlock(
                `Copying top store paths with their closures`,
                async () => {
                    // TODO check sigs?
                    // https://nixos.org/manual/nix/unstable/command-ref/new-cli/nix3-copy.html#options
                    await utils.bash(
                        `
                        sudo rm -rf ${nixCacheDump}/*
                        
                        LOGS=${nixCache}/logs

                        cat ${workingSetTmp} \\
                            | xargs -I {} bash -c 'nix copy --no-check-sigs --to ${nixCacheDump} {}' 2> $LOGS
                        
                        nix copy --to ${nixCacheDump} nixpkgs#findutils 2>> $LOGS

                        cat $LOGS
                        `
                    );
                }
            );

            await utils.logBlock(
                "Listing Nix store paths to be cached.",
                async () => {
                    await utils.bash(
                        `find ${nixCacheDump}/nix/store -mindepth 1 -maxdepth 1 -exec du -sh {} \\;`
                    );
                }
            );
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
