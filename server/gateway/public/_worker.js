// Keep the same server-side password checks and storage behind a Pages URL.
export default {
  fetch(request, env) { return env.NOTES.fetch(request); }
};
