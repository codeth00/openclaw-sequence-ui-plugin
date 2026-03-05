# Publish to GitHub

## 1) Initialize and commit

```bash
cd /Users/codeth/.openclaw/openclaw-sequence-dashboard-plugin
git init
git add .
git commit -m "feat: initial OpenClaw sequence dashboard plugin"
```

## 2) Create GitHub repo and push

Using GitHub CLI:

```bash
gh repo create <YOUR_ORG>/openclaw-sequence-dashboard-plugin --public --source . --remote origin --push
```

Or manual remote:

```bash
git remote add origin git@github.com:<YOUR_ORG>/openclaw-sequence-dashboard-plugin.git
git branch -M main
git push -u origin main
```

## 3) Optional release tag

```bash
git tag v0.1.0
git push origin v0.1.0
```
