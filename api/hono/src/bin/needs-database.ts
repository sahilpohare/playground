import "@packages/env/load-dotenv"

// ask, thread, ingest and dm upload read the database, which first run's setup has not made while POSTGRES_URL is empty, so they say so in one line rather than throw @packages/env/db's issue dump; imported before it validates, and on the same skip flags its polyfill reads.
const skipped =
  process.env.SKIP_ENV_VALIDATION === "true" || process.env.SKIP_ENV_VALIDATION_SERVER === "true"
if (!process.env.POSTGRES_URL && !skipped) {
  console.error("No database yet: finish first-run setup on the Dashboard, then run this again.")
  process.exit(1)
}
