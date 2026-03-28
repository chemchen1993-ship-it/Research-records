# GitHub Push Commands

This repository already has the first local commit prepared.

Replace the example repository URL below with your real GitHub repository URL, then run:

```powershell
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

If you create the GitHub repository with SSH instead of HTTPS, use:

```powershell
git remote add origin git@github.com:YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

If `origin` already exists and you want to replace it:

```powershell
git remote remove origin
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```
