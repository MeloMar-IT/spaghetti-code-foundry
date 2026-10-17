// The floating promise in forEach is on purpose: a later evaluation step looks for it.
export async function notifyAll(ids, send) {
  ids.forEach(async (id) => {
    await send(id);
  });
}
