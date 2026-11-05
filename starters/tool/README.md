# Tool

A small command that counts the words, lines and characters of a text.

- Give it text: `node tool.mjs "some text"`
- Or pipe it in: `echo some text | node tool.mjs`
- Help: `node tool.mjs --help`
- Try it in the browser: `node tool.mjs --serve`, then open the address it prints.
- Test it: `node --test`

## Pack it

The release recipe makes `out/tool.tar.gz` with the command and this file.

It needs only Node.js. There is nothing to install.
