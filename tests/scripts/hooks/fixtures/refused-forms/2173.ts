import { type Group } from "./_shared"

// The forms the review of this file's source found refused; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "data folder", "home"],
    guards: ["no-extensions-write"],
    rows: ({ LIST }) => [
      [
        "an in-place sed of a quoted variable the hook does not hold, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' "$X"`,
      ],
      [
        "an in-place sed of a variable the hook does not hold, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' $X`,
      ],
      [
        "an in-place sed of a substitution naming the root, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' $(echo ${LIST})`,
      ],
      [
        "an in-place sed of a quoted substitution naming the root, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' "$(echo ${LIST})"`,
      ],
      [
        "an in-place sed of a backtick substitution naming the root, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' \`echo ${LIST}\``,
      ],
      [
        "an in-place sed of a substitution reading a list, on a line read whole",
        `sleep 1; sed -i '' '/(a) .*/d' $(cat list)`,
      ],
    ],
  },
]
