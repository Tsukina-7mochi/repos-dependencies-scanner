import { Octokit } from 'npm:octokit';

type PromiseType<T> = T extends Promise<infer S> ? S : never;
type ExtractArray<T> = T extends Array<any> ? T : never;

const createFileIndex = async function (username: string, octokit: Octokit) {
  const repos = await octokit.rest.repos.listForUser({
    username,
  });

  const contents = repos.data
    .map((content) => ({
      archived: content.archived,
      owner: content.owner.login,
      name: content.name,
    }))
    .filter(({ archived }) => !archived)
    .map((content) => ({
      owner: content.owner,
      name: content.name,
    }));

  type RepoFiles = ExtractArray<
    PromiseType<
      ReturnType<typeof octokit['rest']['repos']['getContent']>
    >['data']
  >;
  const index: Record<string, RepoFiles> = {};
  await Promise.all(contents
    .map(async (content) => {
      const data = (await octokit.rest.repos.getContent({
        owner: content.owner,
        repo: content.name,
        path: '',
      })).data;
      if (Array.isArray(data)) {
        index[`${content.owner}/${content.name}`] = data;
      }
    }));

  return index;
};

export default createFileIndex;
