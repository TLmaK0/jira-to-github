import { input, select, confirm } from '@inquirer/prompts';
import { Version3Client } from 'jira.js';
import { Octokit } from 'octokit';
import * as cliProgress from 'cli-progress';

async function main() {
  const bar1 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

  const username = await input({message: 'Jira username:'});
  const key = await input({message: 'Jira api token:'});

  const host = await input({message: 'Jira host'});
  const client = new Version3Client({
    host: host,
    newErrorHandling: true, // This flag enable new error handling.
    authentication: {
      basic: {
        email: username,
        apiToken: key
      }
    }
  });

  const projects = (await client.projects.searchProjects()).values;
  const project = await select({
    message: 'Which project to import?',
    choices: projects.map(project => ({
      name: project.name,
      value: project.id
    }))
  });

  const importIssuesWithStatus = await select({
    message: 'Import all issue or only not done',
    choices: [
      {name: 'Not done', value: ' and status != done'},
      {name: 'All', value: ''},
    ]
  });

  const jql = `project = ${project}${importIssuesWithStatus} AND type != Epic order by created DESC`;

  const search = await client.issueSearch.searchForIssuesUsingJql({
    jql: jql,
  });

  const githubKey = await input({message: 'Github api token:'});

  const octokit = new Octokit({
    auth: githubKey,
    throttle: {
      onRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`
        );

        octokit.log.warn(`Retrying after ${retryAfter} seconds!`);
        return true;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit) => {
        octokit.log.warn(
          `SecondaryRateLimit detected for request ${options.method} ${options.url}`
        );

        octokit.log.warn(`Retrying after ${retryAfter} seconds!`);
        return true;
      },
    }
  });

  const auth = await octokit.rest.users.getAuthenticated();

  if (!auth.data?.login) {
    throw new Error("Github authentication fail");
  };

  console.log(`Logged in github with user ${auth.data.login}.`);
  const organizations = (await octokit.rest.orgs.listForAuthenticatedUser()).data;

  const organization = await select({
    message: 'Select an organization from github',
    choices: organizations.map(organization => ({
      name: organization.login,
      value: organization
    }))
  });

  const repositories = (await octokit.rest.repos.listForOrg({org: organization.login, per_page: 100})).data;

  const repository = await select({
    message: `Select a repository from ${organization.login}`,
    choices: repositories.map(repository => ({
      name: repository.name,
      value: repository
    }))
  });

  const labels = (await octokit.rest.issues.listLabelsForRepo({owner: repository.owner.login, repo: repository.name})).data;

  const label = await select({
    message: `Select a label`,
    choices: labels.map(label => ({
      name: label.name,
      value: label
    }))
  });

  const importIssues = await confirm({
    message: `Are you sure that you want to import ${search.total} issues?`,
    default: false
  });

  if (!importIssues) return;

  const pageSize = 3;

  bar1.start(search.total, 0);

  for(var issueNum = 0; issueNum <= search.total; issueNum += pageSize) {
    const search = (await client.issueSearch.searchForIssuesUsingJql({
      jql: jql,
      startAt: issueNum,
      maxResults: pageSize
    }));

    const results = [];

    for(const issue of search.issues) {
      const description = issue.fields.description?.content
          .filter(content1 => content1.type == 'paragraph')
          .map(content1 => content1.content
            .filter(content2 => content2.type == 'text')
            .map(content2 => content2.text).join('\r\n')
          ).join(`\r\n`)||'';


      const result = octokit.rest.issues.create({
        owner: repository.owner.login,
        repo: repository.name,
        title: `${issue.fields.summary} [${issue.key}]`,
        body: `
${description}
[#${issue.key}](${host}/browse/${issue.key})
        `,
        labels: [label.name]
      });
      results.push(result);
    }
    
    await Promise.all(results);
    bar1.increment(search.issues.length);
  };
  bar1.stop();
}

await main();
