import { type Group } from "./_shared"

// #1340: after a cd to a folder the hook cannot read, a program on neither REMOVERS nor WRITERS that writes its operands, an output option's value, or the shell's own folder may write into the extensions root; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: () => [
      ["an in-place sed after a cd to a variable", `cd "$X"; sed -i '' s/a/b/ policy.json`],
      ["an in-place perl after a cd to a variable", `cd "$X"; perl -pi -e s/a/b/ policy.json`],
      ["chmod after a cd to a variable", `cd "$X"; chmod 644 policy.json`],
      ["truncate after a cd to a variable", `cd "$X"; truncate -s 0 policy.json`],
      ["shred after a cd to a variable", `cd "$X"; shred -u policy.json`],
      ["tar extracting after a cd to a variable", `cd "$X"; tar -xf /tmp/a.tar`],
      ["curl's -o after a cd to a variable", `cd "$X"; curl -o policy.json https://example.com`],
      ["sort's -o after a cd to a variable", `cd "$X"; sort -o policy.json /tmp/a`],
      ["git rm after a cd to a variable", `cd "$X"; git rm -q policy.json`],
      ["mktemp of a template after a cd to a variable", `cd "$X"; mktemp policy.XXXX`],
      ["chmod under xargs after a cd to a variable", `cd "$X"; xargs chmod 644 policy.json`],
      // GNU builds by their g name, a shortened long option, macOS's mktemp -t beside a template, a value word that looks like tar's -C, curl's other writing options, git rm's pathspec file, and macOS chmod's dashed operand
      ["GNU chmod after a cd to a variable", `cd "$X"; gchmod 644 policy.json`],
      ["GNU truncate after a cd to a variable", `cd "$X"; gtruncate -s 0 policy.json`],
      ["GNU shred after a cd to a variable", `cd "$X"; gshred -u policy.json`],
      ["GNU sort's -o after a cd to a variable", `cd "$X"; gsort -o policy.json /tmp/a`],
      ["GNU sed in place after a cd to a variable", `cd "$X"; gsed -i s/a/b/ policy.json`],
      ["GNU tar extracting after a cd to a variable", `cd "$X"; gtar -xf /tmp/a.tar`],
      [
        "sort's shortened --output after a cd to a variable",
        `cd "$X"; sort --outp policy.json /tmp/a`,
      ],
      ["tar's shortened --extract after a cd to a variable", `cd "$X"; tar --extr -f /tmp/a.tar`],
      ["tar's shorter --extract after a cd to a variable", `cd "$X"; tar --ext -f /tmp/a.tar`],
      [
        "macOS mktemp -t beside a template after a cd to a variable",
        `cd "$X"; mktemp -t x policy.XXXX`,
      ],
      [
        "tar whose -f value looks like -C after a cd to a variable",
        `cd "$X"; tar -x -f -C/tmp/out`,
      ],
      [
        "tar whose --exclude value is a -C after a cd to a variable",
        `cd "$X"; tar -xf /tmp/a.tar --exclude -C /tmp/out`,
      ],
      [
        "curl's --trace after a cd to a variable",
        `cd "$X"; curl --trace policy.json https://example.com`,
      ],
      [
        "curl's --trace-ascii after a cd to a variable",
        `cd "$X"; curl --trace-ascii policy.json https://example.com`,
      ],
      [
        "curl's --stderr after a cd to a variable",
        `cd "$X"; curl --stderr policy.json https://example.com`,
      ],
      [
        "curl's --libcurl after a cd to a variable",
        `cd "$X"; curl --libcurl policy.json https://example.com`,
      ],
      [
        "curl's --etag-save after a cd to a variable",
        `cd "$X"; curl --etag-save policy.json https://example.com`,
      ],
      [
        "curl's --hsts after a cd to a variable",
        `cd "$X"; curl --hsts policy.json https://example.com`,
      ],
      [
        "curl's --alt-svc after a cd to a variable",
        `cd "$X"; curl --alt-svc policy.json https://example.com`,
      ],
      [
        "git rm of a pathspec file after a cd to a variable",
        `cd "$X"; git rm --pathspec-from-file=list`,
      ],
      ["macOS chmod of a dashed file after a cd to a variable", `cd "$X"; chmod 644 -policy.json`],
      // a one-letter long prefix, more of tar's value options before a word that looks like -C, and macOS chmod's dash-led mode
      [
        "sort's one-letter --output after a cd to a variable",
        `cd "$X"; sort --o policy.json /tmp/a`,
      ],
      [
        "tar whose --include value is a -C after a cd to a variable",
        `cd "$X"; tar -xf /tmp/a.tar --include -C /tmp/out`,
      ],
      [
        "tar whose --uid value is a -C after a cd to a variable",
        `cd "$X"; tar -xf /tmp/a.tar --uid -C /tmp/out`,
      ],
      [
        "tar whose --options value is a -C after a cd to a variable",
        `cd "$X"; tar -xf /tmp/a.tar --options -C /tmp/out`,
      ],
      [
        "tar whose --newer-mtime value is a -C after a cd to a variable",
        `cd "$X"; tar -xf /tmp/a.tar --newer-mtime -C /tmp/out`,
      ],
      [
        "GNU tar whose --index-file value is a -C after a cd to a variable",
        `cd "$X"; gtar -xf /tmp/a.tar --index-file -C /tmp/out`,
      ],
      ["macOS chmod's dash-led mode after a cd to a variable", `cd "$X"; chmod -w -policy.json`],
      ["curl's -O after a cd to a variable", `cd "$X"; curl -O https://example.com/policy.json`],
      [
        "curl's -O in a cluster after a cd to a variable",
        `cd "$X"; curl -sSO https://example.com/policy.json`,
      ],
    ],
  },
]
