# lovagentic examples

Copy-paste-ready recipes for common lovagentic workflows.

## Index

| Example | What | For |
|---|---|---|
| [`crm-template/`](./crm-template) | Build a CRM dashboard from a single prompt, iterate, publish, verify | End-to-end demo |
| [`github-actions-smoke-test.yml`](./github-actions-smoke-test.yml) | CI job that verifies a Lovable preview on every PR and uploads screenshots | CI/CD |
| [`github-actions-lighthouse.yml`](./github-actions-lighthouse.yml) | CI job that audits a Lovable preview on every PR | Performance gates |
| [`batch-verify.sh`](./batch-verify.sh) | Shell script that loops all your Lovable projects and captures a screenshot of each | Batch ops |

## Trying them out

All examples assume you already have lovagentic installed and signed in:

```bash
npm install -g lovagentic
lovagentic import-desktop-session
lovagentic doctor   # should show all green ✓
```

See [the main README](../README.md) for the full install + setup flow.

## Contributing

Have a useful recipe? Open a PR adding a folder or file here. Small + focused beats big + generic. Include a short README or header comment that says what the recipe does and what assumptions it makes.
