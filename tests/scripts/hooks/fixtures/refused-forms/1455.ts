import { type Group, NEVER_MADE } from "./_shared"

// #1455: a read whose pattern argument holds glob characters or names a gated call, which no-extensions-write read as a path or a command line, beside a write through the same shape that it still refuses; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "tmp"],
    guards: ["no-extensions-write"],
    rows: ({ LIST, ROOT, SCOPE, WORK }) => [
      [
        "a grep whose quoted regex reads as a glob under the home",
        `grep -rn '/Users/.*/x' ${WORK}`,
      ],
      ["a grep -e with its path", `grep -n -e '/Users/.*/x' ${WORK}/a.ts`],
      ["a piped filter", `cat ${WORK}/a.ts | grep '/kept'`],
      ["an awk program over a path under the home", `awk '{print $1}' ${WORK}/runs.log`],
      ["an awk regex in slashes", `awk '/lanes/ {print $2}' ${WORK}/runs.log`],
      ["a sed range address", `sed -n '/pattern/,+3p' ${WORK}/a.ts`],
      [
        "an in-place sed whose /regex/d holds a ( and a backtick",
        `sed -i '' '/kept.push(\`worktree /d' ${WORK}/a.ts`,
      ],
      ["an in-place sed whose /regex/d holds a (", `sed -i '' '/kept.push(/d' ${WORK}/a.ts`],
      ["an in-place sed whose suffix is attached", `sed -i.bak '/a*b/d' ${WORK}/a.ts`],
      [
        "an in-place sed whose s/// holds a ( and its flags",
        `sed -n -i '' 's/a(/b/gp' ${WORK}/a.ts`,
      ],
      ["an in-place sed whose -e script holds a [", `sed -i '' -e '/a[bc]/d' ${WORK}/a.ts`],
      ["an in-place sed whose range holds a ?", `sed -i '' '/ab?/,/end/d' ${WORK}/a.ts`],
      [
        "a quiet commit whose message names playground migrate",
        `git commit -q -m 'fix: playground migrate seeds the lists'`,
      ],
      ["a grep whose output is redirected into the root", `grep -rn '/a(' ${WORK} > ${LIST}`],
      ["an awk program that prints into the root", `awk '/a(/ {print > "${LIST}"}' ${WORK}/a.ts`],
      ["an in-place sed on a file in the root", `sed -i '' '/a(/d' ${SCOPE}/x.json`],
      ["an in-place sed on a glob of the root", `sed -i '' '/a(/d' ${ROOT}/*/x`],
      [
        "an in-place sed whose script writes a w file into the root",
        `sed -i '' '/a(/w ${SCOPE}/x' ${WORK}/a.ts`,
      ],
      [
        "an in-place sed whose script runs an e command",
        `sed -i '' '/a(/e rm -rf ${NEVER_MADE}' ${WORK}/a.ts`,
      ],
      [
        "an in-place sed whose backup suffix names another folder",
        `sed -i'.playground/extensions/*' '/a(/d' ${WORK}/a.ts`,
      ],
      ["an in-place sed on the root by a variable", `F=${SCOPE}/x; sed -i '' '/a(/d' "$F"`],
      [
        "an in-place sed on the root's path relative to the home",
        `sed -i '' '/a(/d' .playground/extensions/login/x`,
        "home",
      ],
      [
        "an in-place sed whose bare -i takes a /regex/d holding a * as its suffix",
        `sed -i '/a*b/d' ${WORK}/a.ts`,
      ],
      [
        "an in-place sed whose bare -i takes a harmless script as its suffix, before a w through a link to the root",
        `cd ${WORK} && sed -i p '/x/w ../store/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose bare -i takes a harmless script as its suffix, before a w through a link to the data folder",
        `cd ${WORK} && sed -i p '/x/w ../pg/extensions/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose bare -i takes a harmless script as its suffix, before a w from the home",
        `sed -i p '/x/w store/login/x' work/a.ts`,
        "home",
      ],
      [
        "an in-place sed -n whose bare -i takes a harmless script as its suffix, before a w through a link",
        `cd ${WORK} && sed -n -i p '/x/w ../store/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose script writes a W file through a link to the root",
        `cd ${WORK} && sed -i '' '/x/W ../store/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose s/// writes its w file through a link to the root",
        `cd ${WORK} && sed -i '' 's/x/y/w ../store/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose s/// runs its e flag",
        `sed -i '' 's/x/rm -rf ${NEVER_MADE} #/e' ${WORK}/a.ts`,
      ],
      [
        "an in-place sed whose script reads an r file through a link to the root",
        `cd ${WORK} && sed -i '' '/x/r ../store/login/x' a.ts`,
        "home",
      ],
      [
        "an in-place sed whose script comes from a -f file through a link to the root",
        `cd ${WORK} && sed -i '' -f ../store/login/x.sed a.ts`,
        "home",
      ],
      [
        "a quiet commit whose message holds the root's path",
        `git commit -m "fix: playground migrate in ${ROOT}"`,
      ],
      ["a gated call after a quiet commit", `git commit -m 'fix: x' && playground migrate`],
    ],
  },
]

export const allowed: string[] = [
  "a grep whose quoted regex reads as a glob under the home",
  "a grep -e with its path",
  "a piped filter",
  "an awk program over a path under the home",
  "an awk regex in slashes",
  "a sed range address",
  "an in-place sed whose /regex/d holds a ( and a backtick",
  "an in-place sed whose /regex/d holds a (",
  "an in-place sed whose suffix is attached",
  "an in-place sed whose s/// holds a ( and its flags",
  "an in-place sed whose -e script holds a [",
  "an in-place sed whose range holds a ?",
  "a quiet commit whose message names playground migrate",
  // #2320: a glob in / reaches the root only through a name it may match there, and neither backup path matches one: the suffix's folder sits under /tmp, and the bare -i's * stands for the file's name, never a glob
  "an in-place sed whose backup suffix names another folder | no-extensions-write | tmp",
  "an in-place sed whose bare -i takes a /regex/d holding a * as its suffix | no-extensions-write | home",
  "an in-place sed whose bare -i takes a /regex/d holding a * as its suffix | no-extensions-write | tmp",
]
