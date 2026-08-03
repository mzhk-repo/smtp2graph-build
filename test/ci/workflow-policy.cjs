const { readFileSync } = require('node:fs');

const workflow = readFileSync('.github/workflows/release-ci.yml', 'utf8');
const fail = (message) => { throw new Error(`workflow policy: ${message}`); };

if (!workflow.includes("branches: [dev]")) fail('PR and development push must target dev.');
if (!workflow.includes("tags: ['v*']")) fail('release path must require a version tag.');
if (/\bdeploy:\s*true\b/.test(workflow)) fail('build plane must never request deploy.');
if ((workflow.match(/shared-ci-cd\.yml@main/g) || []).length !== 2) fail('@main is allowed only for shared-ci-cd.yml callers.');
if (/uses:\s+(?!mzhk-repo\/shared-workflows\/\.github\/workflows\/shared-ci-cd\.yml@main)[^\n]+@v\d/m.test(workflow)) fail('Actions must use immutable commit SHAs.');
if (/:latest\b/.test(workflow)) fail('container images must use immutable digests.');
if (!workflow.includes('push_docker_image: true')) fail('development and tag paths must publish images.');
console.log('PASS: build-plane workflow policy is build-only and immutable.');
