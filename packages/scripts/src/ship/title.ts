// ship:title vX.Y.Z: checks that the new version on GitHub is named by its tag, since a create with no --title takes the tagged commit's subject; prints the fix line and exits 1 when it is not.

// Pure: the refusal for `gh release view <tag> --json name,tagName`'s output, or null when the name is the tag.
export function titleRefusal(view: string): string | null {
  const { name, tagName } = JSON.parse(view) as { name: string; tagName: string }
  if (name === tagName) return null
  return `ship:title: ${tagName} is named "${name}", not its tag: run gh release edit ${tagName} --title ${tagName}`
}

if (import.meta.main) {
  const [tag] = process.argv.slice(2)
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error("usage: bun run ship:title vX.Y.Z")
    process.exit(1)
  }
  const view = Bun.spawnSync(["gh", "release", "view", tag, "--json", "name,tagName"])
  if (view.exitCode !== 0) {
    console.error(
      `ship:title: gh release view ${tag} exited ${view.exitCode}: ${view.stderr.toString().trim()}`,
    )
    process.exit(1)
  }
  const refusal = titleRefusal(view.stdout.toString())
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  console.log(`ship:title: ${tag} is named ${tag}`)
}
