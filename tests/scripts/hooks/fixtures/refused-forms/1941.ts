import type { Group } from "./_shared"

// The forms the review of this file's source found refused; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home"],
    guards: ["no-playground-leak"],
    rows: () => [
      [
        "a pull request whose title is -H, with no --head",
        "gh pr create -R acme-blue/app --title -H --body ok",
      ],
      [
        "a pull request whose label is --head, with no --head",
        "gh pr create -R acme-blue/app --label --head --title x --body ok",
      ],
      [
        "a pull request whose short title is --head, with no --head",
        "gh pr create -R acme-blue/app -t --head --body ok",
      ],
      [
        "a pull request whose --head is empty",
        'gh pr create -R acme-blue/app --head "" --title x --body ok',
      ],
      [
        "a pull request whose --head= is empty",
        "gh pr create -R acme-blue/app --head= --title x --body ok",
      ],
      [
        "a pull request whose -H is empty",
        "gh pr create -R acme-blue/app -H '' --title x --body ok",
      ],
      [
        "a pull request whose last --head is empty",
        "gh pr create -R acme-blue/app --head main --head '' --title x --body ok",
      ],
      [
        "a pull request whose --head it cannot read",
        'gh pr create -R acme-blue/app --head "$B" --title x --body ok',
      ],
      [
        "a pull request whose --head is only whitespace",
        'gh pr create -R acme-blue/app --head " " --title x --body ok',
      ],
      [
        "a pull request whose --head holds a backtick",
        "gh pr create -R acme-blue/app --head 'fix`x' --title x --body ok",
      ],
      [
        "a pull request whose --head holds a leftover quote",
        `gh pr create -R acme-blue/app --head "fix'x" --title x --body ok`,
      ],
      [
        "a pull request whose --head holds a glob character",
        "gh pr create -R acme-blue/app --head 'fix*' --title x --body ok",
      ],
    ],
  },
]
