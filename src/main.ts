import { Octokit } from '../deps.ts';
import config from '../config.json' assert { type: 'json' };
import createFileIndex from './createFileIndex.ts';
import * as io from 'io';
import {
  checkDepsImportMap,
  checkDepsRecord,
  checkURLStringsEsInText,
  createDenoURLResolver,
  createNpmResolver,
  VersionCheckSummaryItem,
} from './checkDeps.ts';
import { classifyBy, renderTable } from './util.ts';

// authenticate GitHub
const token = await Deno.readTextFile(config.token).then((str) => str.trim());
const octokit = new Octokit({
  auth: token,
});
const authResult = await octokit.rest.users.getAuthenticated();
console.log(`Logged in as ${authResult.data.login}`);

// read index file or create from remote repos
const fileIndex = await Deno.readTextFile(config.index_file)
  .then((content) => JSON.parse(content) as ReturnType<typeof createFileIndex>)
  .catch(async () => {
    console.log('Index file not found. Create it from remote repos? (y/n)');
    // loop until user confirms
    for await (const line_ of io.readLines(Deno.stdin)) {
      const line = line_.trim();
      if (line === 'y' || line === 'Y') {
        break;
      } else if (line === 'n' || line === 'N') {
        throw Error('Index file creation canceled.');
      }
    }
    console.log('Creating index file...');

    // write it to index file
    const fileIndex = await createFileIndex(config.username, octokit);
    await Deno.writeTextFile(config.index_file, JSON.stringify(fileIndex));

    return fileIndex;
  });

const npmResolver = createNpmResolver();
const denoURLResolver = createDenoURLResolver(octokit);

// scan all repos
const summaries: { repoName: string; summary: VersionCheckSummaryItem[] }[] =
  [];
for (const repoName in fileIndex) {
  const files = fileIndex[repoName];
  const fileNames = files.map((file) => file.name);

  console.log(`\x1b[1mRepository: ${repoName}\x1b[0m`);
  let summary: VersionCheckSummaryItem[] = [];

  for (const file of files) {
    for (const confFile in config.files) {
      if (confFile !== file.name) {
        continue;
      }
      const key = confFile as keyof typeof config['files'];
      const fileConfig = config.files[key];

      if (!fileConfig.exists.every((name) => fileNames.includes(name))) {
        continue;
      }
      console.log(`Found ${file.name} in ${repoName}.`);

      // determine which resolver to use
      let resolver = null;
      if (fileConfig.resolve === 'npm') {
        resolver = npmResolver;
      } else if (fileConfig.resolve === 'deno') {
        resolver = denoURLResolver;
      }
      if (resolver === null) {
        console.log(`${fileConfig.resolve} is not valid resolve type.`);
        continue;
      }

      // download remote file
      const downloadURL = file.download_url;
      if (typeof downloadURL !== 'string') {
        console.log(`Unable to download file ${file.name}.`);
        continue;
      }
      const res = await fetch(downloadURL);
      if (!res.ok) {
        console.log(`File ${repoName}/${file.name} is not found.`);
        continue;
      }
      const content = await res.text();

      if (fileConfig.type === 'package.json') {
        const data = JSON.parse(content);
        if (data['dependencies']) {
          summary = [
            ...summary,
            ...(await checkDepsRecord(data['dependencies'], resolver)),
          ];
        }
        if (data['devDependencies']) {
          summary = [
            ...summary,
            ...(await checkDepsRecord(data['devDependencies'], resolver)),
          ];
        }
      } else if (fileConfig.type === 'importmap') {
        const data = JSON.parse(content);
        summary = [
          ...summary,
          ...(await checkDepsImportMap(data, resolver)),
        ];
      } else if (fileConfig.type === 'es-url') {
        summary = [
          ...summary,
          ...(await checkURLStringsEsInText(content, resolver)),
        ];
      }
    }
  }

  summaries.push({ repoName, summary });
}

// export summary
console.log('== SUMMARY ==');
const repoNumNeedFix = summaries
  .filter(({ summary }) =>
    summary.some((item) => item.checkResult !== 'latest')
  )
  .length;
console.log(`Number of repos needs fix: \x1b[1m${repoNumNeedFix}\x1b[0m`);

for (const { repoName, summary } of summaries) {
  const classified = classifyBy(summary, (item) => item.checkResult);
  const latestDeps = classified.get('latest') ?? [];
  const outdatedDeps = classified.get('outdated') ?? [];
  const notFoundDeps = classified.get('not_found') ?? [];
  const invalidVersionDeps = classified.get('invalid_version') ?? [];
  const notFixedDeps = classified.get('not_fixed') ?? [];

  if (latestDeps.length === summary.length) {
    // the repo need no fix
    continue;
  }

  console.log(
    `\x1b[30;107mTotal\x1b[0m ${summary.length} ` +
      `\x1b[30;42mLatest\x1b[0m ${latestDeps.length} ` +
      `\x1b[30;41mOutdated\x1b[0m ${outdatedDeps.length} ` +
      `\x1b[30;41mNot Found\x1b[0m ${notFoundDeps.length} ` +
      `\x1b[30;43mInvalid Version\x1b[0m ${invalidVersionDeps.length} ` +
      `\x1b[30;43mNot Fixed\x1b[0m ${notFixedDeps.length} `,
  );

  const table = [
    ['\x1b[30;41m\x1b[0m', 'Package', 'Current', 'Latest'],
    ...outdatedDeps.map((dep) => [
      '\x1b[30;41m Outdated \x1b[0m',
      dep.packageName,
      dep.currentVersion ?? 'null',
      dep.latestVersion ?? 'null',
    ]),
    ...notFoundDeps.map((dep) => [
      '\x1b[30;41m Not found \x1b[0m',
      dep.packageName,
      dep.currentVersion ?? 'null',
      dep.latestVersion ?? 'null',
    ]),
    ...invalidVersionDeps.map((dep) => [
      '\x1b[30;43m Invalid Version \x1b[0m',
      dep.packageName,
      dep.currentVersion ?? 'null',
      dep.latestVersion ?? 'null',
    ]),
    ...notFixedDeps.map((dep) => [
      '\x1b[30;43m Not Fixed \x1b[0m',
      dep.packageName,
      dep.currentVersion ?? 'null',
      dep.latestVersion ?? 'null',
    ]),
  ];

  const renderedTable = renderTable(table);
  console.log(renderedTable);

  if (notFixedDeps.length > 0) {
    console.log(
      '⚠️ Packages with no fixed version may be locked to an outdated version.',
    );
  }
}
