# Web app

A small web app: one page with a form, and a small JSON API that stores what you enter.

- Look at it: `node server.mjs`, then open the address it prints.
- Test it: `node --test`
- The page and the API are in `server.mjs`.

## Your data

Entries are stored in `data/entries.json`. Git ignores the `data/` folder, so your entries are not committed.

You can choose another file with the `DATA_FILE` environment variable. If you pick a place inside the project other than `data/`, add it to `.gitignore` first, before you store anything.

If the data file is damaged, the app does not touch it. It answers with an error until you fix or remove the file.

## Pack it

The release recipe makes `out/web-app.tar.gz`.

It needs only Node.js. There is nothing to install.
