import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DefaultTheme } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const decisionsDir = fileURLToPath(new URL('../decisions', import.meta.url));

/**
 * Builds sidebar items for the architecture decision records in
 * `docs/decisions/`, using each record's first heading as its title.
 */
function decisionSidebarItems(): DefaultTheme.SidebarItem[] {
  return fs
    .readdirSync(decisionsDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .sort()
    .map((fileName) => {
      const contents = fs.readFileSync(
        path.join(decisionsDir, fileName),
        'utf8',
      );
      const heading = contents.match(/^# (.+)$/m);
      return {
        text: heading?.[1] ?? fileName,
        link: `/decisions/${fileName.replace(/\.md$/, '')}`,
      };
    });
}

/**
 * Package reference pages grouped by lifecycle phase, mirroring the
 * categories in the packages overview table.
 */
const packageGroups: Record<string, string[]> = {
  Discovery: ['dataset', 'dataset-registry-client'],
  Processing: [
    'pipeline',
    'pipeline-shacl-sampler',
    'pipeline-shacl-validator',
    'pipeline-void',
    'distribution-downloader',
    'distribution-health',
    'distribution-probe',
    'iiif-validator',
    'sparql-importer',
  ],
  Publication: [
    'fastify-rdf',
    'docgen',
    'search',
    'search-api-graphql',
    'search-api-server',
    'search-indexer',
    'search-pipeline',
    'search-typesense',
    'text-normalization',
  ],
  Monitoring: ['distribution-monitor', 'pipeline-console-reporter'],
  Infrastructure: [
    'local-sparql-endpoint',
    'sparql-server',
    'sparql-qlever',
    'wait-for-sparql',
    'task-runner',
    'task-runner-docker',
    'task-runner-native',
  ],
};

function packageSidebarItems(): DefaultTheme.SidebarItem[] {
  return Object.entries(packageGroups).map(([group, packages]) => ({
    text: group,
    collapsed: true,
    items: packages.map((name) => ({
      text: name,
      link: `/reference/${name}`,
    })),
  }));
}

const referenceSidebar: DefaultTheme.SidebarItem[] = [
  { text: 'Overview', link: '/reference/' },
  {
    text: 'Packages',
    link: '/reference/packages',
    items: packageSidebarItems(),
  },
  {
    text: 'Decisions',
    collapsed: true,
    items: decisionSidebarItems(),
  },
];

export default withMermaid({
  mermaid: {
    look: 'handDrawn',
  },
  title: 'LDE',
  description:
    'Linked Data Elements – shared building blocks for the full Linked Data lifecycle.',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: 'https://ldelements.org',
  },
  themeConfig: {
    nav: [
      {
        text: 'Guide',
        link: '/guide/',
        activeMatch: '/guide/',
      },
      {
        text: 'Reference',
        link: '/reference/',
        activeMatch: '/(reference|decisions)/',
      },
    ],
    sidebar: {
      '/guide/': [
        { text: 'Overview', link: '/guide/' },
        {
          text: 'Introduction',
          items: [
            { text: 'What is LDE?', link: '/guide/what-is-lde' },
            { text: 'When to use LDE', link: '/guide/when-to-use-lde' },
            { text: 'Core concepts', link: '/guide/core-concepts' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Tutorials',
          items: [
            { text: 'Build a pipeline', link: '/guide/build-a-pipeline' },
            { text: 'Build a search API', link: '/guide/build-a-search-api' },
          ],
        },
        {
          text: 'How-to',
          items: [
            {
              text: 'Pipeline',
              items: [
                {
                  text: 'Select datasets from a registry',
                  link: '/guide/select-datasets-from-a-registry',
                },
                {
                  text: 'Import data dumps',
                  link: '/guide/import-data-dumps',
                },
                {
                  text: 'Adapt timeouts to endpoint health',
                  link: '/guide/adapt-timeouts-to-endpoint-health',
                },
                {
                  text: 'Validate output with SHACL',
                  link: '/guide/validate-pipeline-output',
                },
                {
                  text: 'Skip unchanged datasets',
                  link: '/guide/skip-unchanged-datasets',
                },
                {
                  text: 'Extend a stage with a quad transform',
                  link: '/guide/extend-a-stage-with-a-quad-transform',
                },
                {
                  text: 'Write a plugin',
                  link: '/guide/write-a-pipeline-plugin',
                },
                {
                  text: 'Observe a run with a reporter',
                  link: '/guide/observe-a-run-with-a-reporter',
                },
                {
                  text: 'Chain stage outputs',
                  link: '/guide/chain-stage-outputs',
                },
                {
                  text: 'Analyze a dataset with VoID',
                  link: '/guide/analyze-a-dataset-with-void',
                },
                {
                  text: 'Test against a local endpoint',
                  link: '/guide/test-a-pipeline-locally',
                },
              ],
            },
            {
              text: 'Publication',
              items: [
                {
                  text: 'Serve RDF with content negotiation',
                  link: '/guide/serve-rdf-with-content-negotiation',
                },
                {
                  text: 'Generate documentation from SHACL shapes',
                  link: '/guide/generate-documentation-from-shacl',
                },
              ],
            },
          ],
        },
      ],
      '/reference/': referenceSidebar,
      '/decisions/': referenceSidebar,
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ldelements/lde' },
    ],
    search: {
      provider: 'local',
    },
    editLink: {
      pattern: 'https://github.com/ldelements/lde/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
