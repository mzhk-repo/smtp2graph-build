#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build
./node_modules/.bin/mocha test/00unit/MailQueue.spec.ts
npm run test:receive -- --logging error
node test/ci/workflow-policy.cjs
