import * as semver from 'semver';
import { Octokit } from '../deps.ts';

type VersionCache = Map<string, string | null>;
/** Resolves resource(e.g. package name and URL) into current and latest versions */
export type Resolver = (
  resource: string,
) => Promise<[string | null, string | null]>;
export type ImportMap = { imports: Record<string, string> } & {
  [key: string]: any;
};
export type VersionCheckResult =
  | 'latest'
  | 'outdated'
  | 'not_found'
  | 'invalid_version'
  | 'not_fixed';
export interface VersionCheckSummaryItem {
  packageName: string;
  currentVersion: string | null;
  latestVersion: string | null;
  checkResult: VersionCheckResult;
}

const logLatest = function (pkgName: string, version: string) {
  console.log(`✅ ${pkgName}: Latest (${version})`);
};
const logOutdated = function (
  pkgName: string,
  curVer: string,
  latestVer: string,
) {
  console.log(`❌ ${pkgName}: ${curVer} -> ${latestVer} Update available`);
};
const logNotFound = function (pkgName: string) {
  console.log(`❌ ${pkgName}: not found`);
};
const logInvalidVersion = function (pkgName: string, versionStr: string) {
  console.log(`❔ ${pkgName}: invalid version specifier (${versionStr})`);
};
const logVersionNotFixed = function (pkgName: string, version: string) {
  console.log(`⚠️ ${pkgName}: Version not fixed (${version})`);
};

/**
 * @example "package@version" -> ["package", "version"]
 * @example "package" -> ["package", ""]
 * @example "@author/package@version" -> ["@author/package", "version"]
 * @example "@author/package" -> ["@author/package"]
 */
const decomposePackageNameVersion = function (pkgStr: string) {
  const index = pkgStr.lastIndexOf('@');
  if (index <= 0) {
    return [pkgStr, ''];
  } else {
    return [pkgStr.slice(0, index), pkgStr.slice(index + 1)];
  }
};

// cached package versions to reduce fetch request
const npmDepsCache: VersionCache = new Map();
const denoLandDepsCache: VersionCache = new Map();
const gitHubDepsCache: VersionCache = new Map();

/**
 * resolves npm package name into latest version;
 * current version is always null
 */
const createNpmResolver = () =>
  async function (pkgName: string): ReturnType<Resolver> {
    const cachedVersion = npmDepsCache.get(pkgName);
    if (typeof cachedVersion === 'string') {
      return [null, cachedVersion];
    }

    const res = await fetch(`https://registry.npmjs.org/${pkgName}`);
    if (!res.ok) {
      npmDepsCache.set(pkgName, null);
      return [null, null];
    }
    const data = JSON.parse(await res.text());
    const version = data['dist-tags']['latest'] as string;

    npmDepsCache.set(pkgName, version);
    return [null, version];
  } as Resolver;
const npmResolver = createNpmResolver();

/** resolves deno.land url into current and latest version */
const resolveDenoLand = async function (url: URL): ReturnType<Resolver> {
  const path = url.pathname.split('/').slice(1);
  const pkgStr = path[0] !== 'x' ? path[0] : path[1];
  const [pkgName, pkgVersion] = decomposePackageNameVersion(pkgStr);

  const cachedVersion = denoLandDepsCache.get(pkgName);
  if (typeof cachedVersion === 'string') {
    return [pkgVersion, cachedVersion];
  }

  const res = await fetch(`https://apiland.deno.dev/v2/modules/${pkgName}`);
  if (!res.ok) {
    denoLandDepsCache.set(pkgName, null);
    return [pkgVersion, null];
  }
  const data = JSON.parse(await res.text());
  const latestVersion = data['latest_version'] as string;

  denoLandDepsCache.set(pkgName, latestVersion);
  return [pkgVersion, latestVersion];
};

const resolveGitHub = async function (
  url: URL,
  octokit: Octokit,
): ReturnType<Resolver> {
  const path = url.pathname.split('/').slice(1);
  const pkgName = `${path[0]}/${path[1]}`;
  const pkgVersion = path[2]; // may be tag or branch name

  const cachedVersion = gitHubDepsCache.get(pkgName);
  if (typeof cachedVersion === 'string') {
    return [pkgVersion, cachedVersion];
  }

  const latestReleaseRes = await octokit.rest.repos.getLatestRelease({
    owner: path[0],
    repo: path[1],
  });
  const latestVersion = semver.clean(latestReleaseRes.data.tag_name ?? '');
  gitHubDepsCache.set(pkgName, latestVersion);

  return [pkgVersion, latestVersion];
};

const createDenoURLResolver = (octokit: Octokit) =>
  async function (url_: string): ReturnType<Resolver> {
    if (url_.startsWith('npm:')) {
      const [pkgName, pkgVersion] = decomposePackageNameVersion(url_.slice(4));
      const [_, latestVersion] = await npmResolver(pkgName);

      return [pkgVersion, latestVersion];
    }

    let url: URL;
    try {
      url = new URL(url_);
    } catch {
      return [null, null];
    }

    if (url.hostname === 'deno.land') {
      return await resolveDenoLand(url);
    } else if (url.hostname === 'raw.githubusercontent.com') {
      return await resolveGitHub(url, octokit);
    }

    return [null, null];
  } as Resolver;

const checkVersion = function (
  pkgName: string,
  curVer: string | null,
  latestVer: string | null,
): VersionCheckResult {
  if (!curVer) {
    logInvalidVersion(pkgName, 'null');
    return 'invalid_version';
  }

  if (!latestVer) {
    logNotFound(pkgName);
    return 'not_found';
  }

  const latestVerValid = semver.valid(latestVer);
  if (!latestVerValid) {
    logInvalidVersion(pkgName, latestVer);
    return 'invalid_version';
  }

  let greater = false;
  try {
    greater = semver.gtr(latestVerValid, curVer);
  } catch {
    logInvalidVersion(pkgName, curVer);
    return 'invalid_version';
  }

  if (greater) {
    logOutdated(pkgName, curVer, latestVer);
    return 'outdated';
  } else if (!semver.valid(curVer)) {
    logVersionNotFixed(pkgName, curVer);
    return 'not_fixed';
  }

  logLatest(pkgName, latestVer);
  return 'latest';
};

/**
 * @param packages { [package-name]: [version-string] }
 */
const checkDepsRecord = async function (
  packages: Record<string, string>,
  resolver: Resolver,
): Promise<VersionCheckSummaryItem[]> {
  const summary: VersionCheckSummaryItem[] = [];

  for (const pkgName of Object.keys(packages)) {
    const curVer = packages[pkgName];
    const [_, latestVer] = await resolver(pkgName);

    summary.push({
      packageName: pkgName,
      currentVersion: curVer,
      latestVersion: latestVer,
      checkResult: checkVersion(pkgName, curVer, latestVer),
    });
  }

  return summary;
};

/**
 * @param packages { [package-name]: [resource-URL] }
 */
const checkDepsImportMap = async function (
  packages: ImportMap,
  resolver: Resolver,
): Promise<VersionCheckSummaryItem[]> {
  const summary: VersionCheckSummaryItem[] = [];

  for (const pkgName of Object.keys(packages.imports)) {
    const url = packages.imports[pkgName];
    const [curVer, latestVer] = await resolver(url);

    summary.push({
      packageName: pkgName,
      currentVersion: curVer,
      latestVersion: latestVer,
      checkResult: checkVersion(pkgName, curVer, latestVer),
    });
  }

  return summary;
};

const checkURLStringsEsInText = async function (
  text: string,
  resolver: Resolver,
): Promise<VersionCheckSummaryItem[]> {
  const summary: VersionCheckSummaryItem[] = [];

  const urlRegExp1 = /"https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-@]+"/g;
  const urlRegExp2 = /'https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-@]+'/g;
  const urlRegExp3 = /`https?:\/\/[\w/:%#\$&\?\(\)~\.=\+\-@]+`/g;

  const matches = [
    ...text.matchAll(urlRegExp1),
    ...text.matchAll(urlRegExp2),
    ...text.matchAll(urlRegExp3),
  ];

  for (const match of matches) {
    const url = match[0].slice(1, -1);
    const [curVer, latestVer] = await resolver(url);

    summary.push({
      packageName: url,
      currentVersion: curVer,
      latestVersion: latestVer,
      checkResult: checkVersion(url, curVer, latestVer),
    });
  }

  return summary;
};

export {
  checkDepsImportMap,
  checkDepsRecord,
  checkURLStringsEsInText,
  createDenoURLResolver,
  createNpmResolver,
};
