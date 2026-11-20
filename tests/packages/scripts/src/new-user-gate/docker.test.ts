import { describe, expect, test } from "bun:test"

import {
  BOX_LABEL,
  listedOf,
  narrow,
} from "../../../../../packages/scripts/src/new-user-gate/docker"

const box = "pg-gate-75d1859-9ehNqc"
const listed = listedOf(
  [
    `${"a".repeat(64)}\tplayground-dashboard-db-sY08\t`,
    `${"b".repeat(64)}\t${box}-db-Ab12\t${box}`,
    `${"c".repeat(64)}\t${box}-db-Ab12-old\t${box}`,
    `${"d".repeat(64)}\tpg-gate-fd99ffd-Other1-db-Zz99\tpg-gate-fd99ffd-Other1`,
    "",
  ].join("\n"),
)

describe("the gate box's docker", () => {
  test("lists only the containers the box made, whatever filter the caller adds", () => {
    expect(narrow(["ps", "-a", "--filter", "name=playground-dashboard-db"], box, listed)).toEqual({
      argv: [
        "ps",
        "-a",
        "--filter",
        "name=playground-dashboard-db",
        "--filter",
        `label=${BOX_LABEL}=${box}`,
      ],
    })
  })

  test("labels every container the box starts as its own", () => {
    expect(
      narrow(["run", "-d", "--name", `${box}-db-Zz11`, "postgres:alpine"], box, listed),
    ).toEqual({
      argv: [
        "run",
        "--label",
        `${BOX_LABEL}=${box}`,
        "-d",
        "--name",
        `${box}-db-Zz11`,
        "postgres:alpine",
      ],
    })
  })

  test("hands on a call naming a container the box made", () => {
    for (const argv of [
      ["inspect", `${box}-db-Ab12`],
      ["port", `${box}-db-Ab12`],
      ["exec", `${box}-db-Ab12`, "pg_isready", "-U", "postgres"],
      ["update", "--restart", "unless-stopped", `${box}-db-Ab12`],
      ["rename", `${box}-db-Ab12`, `${box}-db-Ab12-new`],
      [
        "run",
        "-d",
        "--name",
        `${box}-db-Ab12`,
        `--volumes-from=${box}-db-Ab12-old`,
        "postgres:alpine",
      ],
    ])
      expect(narrow(argv, box, listed)).not.toHaveProperty("refused")
  })

  test("refuses a call naming the live dashboard's database, another box's container, or one by its full id", () => {
    expect(narrow(["inspect", "playground-dashboard-db-sY08"], box, listed)).toEqual({
      refused: "inspect playground-dashboard-db-sY08",
    })
    expect(narrow(["exec", "pg-gate-fd99ffd-Other1-db-Zz99", "psql"], box, listed)).toEqual({
      refused: "exec pg-gate-fd99ffd-Other1-db-Zz99",
    })
    expect(narrow(["rm", "-fv", "a".repeat(12)], box, listed)).toEqual({
      refused: `rm ${"a".repeat(12)}`,
    })
    expect(
      narrow(
        ["run", "--volumes-from", "playground-dashboard-db-sY08", "postgres:alpine"],
        box,
        listed,
      ),
    ).toEqual({ refused: "run playground-dashboard-db-sY08" })
  })

  test("refuses every word docker resolves to another's container: a short id prefix, a leading slash, and a name inside name:mode, container:name or name:alias", () => {
    const live = "playground-dashboard-db-sY08"
    for (const argv of [
      ["inspect", "aaaa"],
      ["exec", "a".repeat(11), "psql"],
      ["inspect", `/${live}`],
      ["run", "--volumes-from", `${live}:ro`, "postgres:alpine"],
      ["run", `--volumes-from=${live}:rw`, "postgres:alpine"],
      ["run", "--network", `container:${live}`, "postgres:alpine", "psql", "-h", "127.0.0.1"],
      ["run", `--pid=container:${live}`, "alpine"],
      ["run", `--ipc=container:${live}`, "alpine"],
      ["run", "--link", `${live}:db`, "alpine"],
      ["inspect", `${live}/`],
      ["inspect", `/${live}/`],
      ["inspect", "aaaa/"],
      ["run", "--volumes-from", `${live}/:ro`, "postgres:alpine"],
    ])
      expect(narrow(argv, box, listed)).toHaveProperty("refused")
    expect(
      narrow(
        [
          "run",
          "--volumes-from",
          `${box}-db-Ab12-old:ro`,
          "-p",
          "127.0.0.1::5432",
          "postgres:alpine",
        ],
        box,
        listed,
      ),
    ).not.toHaveProperty("refused")
  })

  test("refuses every call that reaches past the box's own containers, and a named call when docker cannot list", () => {
    for (const sub of [
      "volume",
      "system",
      "cp",
      "context",
      "network",
      "builder",
      "container",
      "image",
    ])
      expect(narrow([sub, "prune", "-f"], box, listed)).toHaveProperty("refused")
    expect(narrow(["inspect", `${box}-db-Ab12`], box, null)).toHaveProperty("refused")
    expect(narrow(["info"], box, null)).toEqual({ argv: ["info"] })
  })

  test("answers the System panel's host-wide reads with the box's own, so a refusal always names a reach", () => {
    const stats = ["stats", "--no-stream", "--format", "{{json .}}"]
    expect(narrow(stats, box, listed)).toEqual({
      argv: [...stats, `${box}-db-Ab12`, `${box}-db-Ab12-old`],
    })
    expect(narrow(stats, "pg-gate-0000000-none", listed)).toEqual({ answer: "" })
    expect(narrow(["stats", "--no-stream", "playground-dashboard-db-sY08"], box, listed)).toEqual({
      refused: "stats playground-dashboard-db-sY08",
    })
    const context = ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]
    expect(narrow(context, box, listed)).toEqual({ argv: context })
    expect(narrow(["context", "rm", "default"], box, listed)).toHaveProperty("refused")
  })

  test.each([
    ["a named volume", ["-v", "pgdata:/var/lib/postgresql/data"]],
    ["a named volume by --mount", ["--mount", "src=pgdata,dst=/x"]],
    ["a volume by --mount=", ["--mount=type=volume,src=pgdata,dst=/x"]],
    ["a host path", ["-v", "/:/host"]],
    ["a host path by --volume=", ["--volume=/Users:/host"]],
    ["the host network", ["--network", "host"]],
    ["the host network by --net=", ["--net=host"]],
    ["a publish past loopback", ["-p", "0.0.0.0::5432"]],
    ["a flag first run never uses", ["--privileged"]],
  ])("refuses a run with %s, logged as its flag", (_, flags) => {
    const argv = ["run", "-d", "--name", `${box}-db-Zz11`, ...flags, "postgres:alpine"]
    expect(narrow(argv, box, listed)).toEqual({
      refused: `run ${flags[0] === "-p" ? flags.join(" ") : flags[0]}`,
    })
  })

  test.each([
    [
      "first run's startArgv",
      [
        "--name",
        `${box}-db-Zz11`,
        "-d",
        "-p",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_USER=postgres",
        "-e",
        "POSTGRES_PASSWORD=pw",
        "-e",
        "POSTGRES_DB=postgres",
        "postgres:alpine",
      ],
    ],
    [
      "the move's loopbackArgv",
      [
        "-d",
        "--name",
        `${box}-db-Ab12`,
        "-p",
        "127.0.0.1:216:5432",
        "--volumes-from",
        `${box}-db-Ab12-old`,
        "--restart",
        "unless-stopped",
        "-e",
        "POSTGRES_PASSWORD=pw",
        "--label",
        "k=v",
        "sha256:abc",
        "postgres",
        "-c",
        "fsync=off",
      ],
    ],
  ])("takes %s whole, the command after the image included", (_, rest) => {
    expect(narrow(["run", ...rest], box, listed)).toEqual({
      argv: ["run", "--label", `${BOX_LABEL}=${box}`, ...rest],
    })
  })
})
