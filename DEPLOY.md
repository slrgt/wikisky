# Deploy XoxoWiki to GitHub Pages

## 1. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new).
2. Set **Repository name** (e.g. `xoxowiki`).
3. Choose **Public**, leave "Add a README" **unchecked**.
4. Click **Create repository**.

## 2. Push this project

In your project folder, run (replace `YOUR_USERNAME` and `YOUR_REPO` with your GitHub username and repo name):

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## 3. Turn on GitHub Pages

1. In the repo on GitHub, go to **Settings** → **Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Under **Branch**, select `main` and `/ (root)`.
4. Click **Save**.

After a minute or two, the site will be at:

**https://YOUR_USERNAME.github.io/YOUR_REPO/**

You can test the wiki there; data is stored in the browser (IndexedDB / local storage) per device.
