/**
 * A shell loop that waits until `<dir>/<file>` exists. It also ends when `dir` is gone or after
 * about 60 seconds, so a test run that dies before its cleanup leaves no endless loop behind.
 * `file` may name a shell variable, such as `$FACTORY_RUN_ID`.
 */
export const waitForFile = (dir: string, file: string): string =>
  `i=0; while [ -d "${dir}" ] && [ ! -e "${dir}/${file}" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`;
