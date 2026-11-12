import { describe, expect, test } from "bun:test"

import {
  checkoutMismatch,
  type Docker,
  GuardError,
  locate,
  loopbackOnly,
  provenLocal,
  publishedOn,
  systemIdentifierOf,
  targetOf,
} from "../../../../../../api/hono/src/lib/sessions/guard"
import { OLD } from "../../../../../session-names"

describe("checkoutMismatch", () => {
  const url = (port: number) => `postgres://postgres:pw@127.0.0.1:${port}/postgres`
  const dotenv = (line: string) => `NODE_ENV=local\n${line}\nREDIS_URL=\n`

  test("names both ports when the URL it runs with is not the one its own checkout's .env names", () => {
    const refused = checkoutMismatch(url(33667), dotenv(`POSTGRES_URL=${url(33673)}`))
    expect(refused).toContain("33667")
    expect(refused).toContain("33673")
  })

  test("reads a quoted or exported line, and a URL with no port as Postgres's own", () => {
    expect(checkoutMismatch(url(33667), dotenv(`export POSTGRES_URL="${url(33673)}"`))).toContain(
      "33673",
    )
    expect(
      checkoutMismatch(url(5433), dotenv("POSTGRES_URL=postgres://postgres:pw@127.0.0.1/postgres")),
    ).toContain("5432")
  })

  test("reads the last POSTGRES_URL line, as a .env loader does", () => {
    expect(
      checkoutMismatch(url(33673), `POSTGRES_URL=${url(1)}\nPOSTGRES_URL=${url(33673)}\n`),
    ).toBeNull()
    expect(
      checkoutMismatch(url(1), `POSTGRES_URL=${url(1)}\nPOSTGRES_URL=${url(33673)}\n`),
    ).toContain("33673")
  })

  test("passes a matching port, and a checkout whose .env names no URL or is missing", () => {
    expect(checkoutMismatch(url(33673), dotenv(`POSTGRES_URL='${url(33673)}'`))).toBeNull()
    expect(checkoutMismatch(url(33673), dotenv("POSTGRES_URL="))).toBeNull()
    expect(checkoutMismatch(url(33673), dotenv("# POSTGRES_URL=" + url(1)))).toBeNull()
    expect(checkoutMismatch(url(33673), null)).toBeNull()
  })
})

describe("targetOf", () => {
  test("a loopback URL names its host, port and database", () => {
    expect(targetOf("postgres://u:p@127.0.0.1:65521/postgres")).toEqual({
      database: "postgres",
      host: "127.0.0.1",
      port: 65521,
    })
    expect(targetOf("postgres://u:p@[::1]/dashboard").host).toBe("::1")
    expect(targetOf("postgres://localhost/dashboard").port).toBe(5432)
  })

  test("any other host is refused before anything connects", () => {
    for (const host of [
      "ep-cool-name.eu-central-1.aws.neon.tech",
      "192.168.1.20:5432",
      "host.docker.internal:5432",
    ]) {
      expect(() => targetOf(`postgres://u:p@${host}/postgres`)).toThrow("not this machine")
    }
  })

  test("its refusal says which check failed, so a caller can name the fix", () => {
    try {
      targetOf("postgres://u:p@db.example.com/postgres")
      throw new Error("targetOf took a remote host")
    } catch (error) {
      expect(error).toBeInstanceOf(GuardError)
      expect((error as GuardError).failure).toBe("remote")
    }
  })
})

const container = (
  name: string,
  bindings: Record<string, { HostIp: string; HostPort: string }[]>,
) => ({
  Config: { Image: "postgres:alpine" },
  Id: `${name}-id`,
  Name: `/${name}`,
  NetworkSettings: { Ports: bindings },
})

describe("publishedOn and loopbackOnly", () => {
  const inspect = [
    container(`${OLD.dispatcher}-desk-db`, {
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "65521" }],
    }),
    container("agents-app-db", {
      "5432/tcp": [
        { HostIp: "0.0.0.0", HostPort: "64918" },
        { HostIp: "::", HostPort: "64918" },
      ],
    }),
    container("web", { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] }),
  ]

  test("finds the container publishing a host port, with every address it binds", () => {
    expect(publishedOn(inspect, 65521)).toEqual([
      {
        addresses: ["127.0.0.1"],
        id: `${OLD.dispatcher}-desk-db-id`,
        image: "postgres:alpine",
        name: `${OLD.dispatcher}-desk-db`,
      },
    ])
    expect(publishedOn(inspect, 64918)[0]?.addresses).toEqual(["0.0.0.0", "::"])
    expect(publishedOn(inspect, 1)).toEqual([])
  })

  test("only a port published on loopback alone passes", () => {
    expect(loopbackOnly(["127.0.0.1"])).toBe(true)
    expect(loopbackOnly(["127.0.0.1", "::1"])).toBe(true)
    expect(loopbackOnly(["0.0.0.0", "::"])).toBe(false)
    expect(loopbackOnly([""])).toBe(false)
    expect(loopbackOnly([])).toBe(false)
  })
})

describe("systemIdentifierOf", () => {
  test("reads the identifier pg_controldata prints", () => {
    expect(
      systemIdentifierOf(
        "pg_control version number:            1800\nDatabase system identifier:           7693260548341198891\n",
      ),
    ).toBe("7693260548341198891")
    expect(systemIdentifierOf("sh: pg_controldata: not found")).toBeNull()
  })
})

const URL_55432 = "postgres://u:p@127.0.0.1:55432/postgres"

const ownDb = container("playground-a-db", {
  "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
})

const vanished = (id: string) =>
  new GuardError("docker-down", `docker inspect failed: Error: No such object: ${id}`)

// A scripted docker: each `ps` hands out the next listing, and `inspect` returns the containers it is asked for or fails as Docker does when one of them has gone.
const scripted = (listings: string[][], gone: string[][], inspect: Record<string, unknown>) => {
  const calls: string[] = []
  let ps = 0
  let inspects = 0
  const run: Docker = (args) => {
    calls.push(args[0] ?? "")
    if (args[0] === "ps") return (listings[ps++] ?? []).join("\n")
    if (args[0] === "inspect") {
      const missing = (gone[inspects++] ?? []).find((id) => args.includes(id))
      if (missing) throw vanished(missing)
      return JSON.stringify(args.slice(1).map((id) => inspect[id]))
    }
    throw new Error(`unexpected docker ${args.join(" ")}`)
  }
  return { calls, run }
}

const failure = (act: () => unknown): GuardError => {
  try {
    act()
  } catch (error) {
    if (error instanceof GuardError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

describe("locate", () => {
  test("a PGlite server on the URL's port owns it, with no Docker call", () => {
    const docker = scripted([], [], {})
    const pglite = (port: number) =>
      port === 55432 ? { home: "/data/pglite/playground-a-db", name: "playground-a-db" } : undefined
    expect(locate(URL_55432, docker.run, pglite)).toEqual({
      owner: {
        addresses: ["127.0.0.1"],
        id: "/data/pglite/playground-a-db",
        image: "pglite",
        name: "playground-a-db",
      },
      pglite: "/data/pglite/playground-a-db",
      target: { database: "postgres", host: "127.0.0.1", port: 55432 },
    })
    expect(docker.calls).toEqual([])
  })

  test("a container gone between the list and the inspect is skipped by one re-list", () => {
    const docker = scripted([["a", "checks"], ["a"]], [["checks"]], { a: ownDb })
    expect(locate(URL_55432, docker.run).owner.name).toBe("playground-a-db")
    expect(docker.calls).toEqual(["ps", "inspect", "ps", "inspect"])
  })

  test("a second vanish refuses as vanished, naming the container, since it re-lists once", () => {
    const docker = scripted(
      [
        ["a", "checks"],
        ["a", "checks-2"],
      ],
      [["checks"], ["checks-2"]],
      {
        a: ownDb,
      },
    )
    const refusal = failure(() => locate(URL_55432, docker.run))
    expect(refusal.failure).toBe("vanished")
    expect(refusal.message).toBe(
      "container checks-2 was removed while the check read Docker, the second in a row",
    )
    expect(docker.calls).toEqual(["ps", "inspect", "ps", "inspect"])
  })

  test("after a re-list the URL's own port must still be proven: no owner refuses", () => {
    const other = container("checks-db", {
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "61000" }],
    })
    const docker = scripted([["checks", "other"], ["other"]], [["checks"]], { other })
    expect(failure(() => locate(URL_55432, docker.run)).failure).toBe("no-owner")
  })

  test("after a re-list a port published beyond loopback still refuses", () => {
    const open = container("playground-a-db", {
      "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }],
    })
    const docker = scripted([["checks", "a"], ["a"]], [["checks"]], { a: open })
    expect(failure(() => locate(URL_55432, docker.run)).failure).toBe("exposed")
  })

  test("a port published on every interface passes only for first run's own container, pglaunch's 4-character suffix on the checkout's name", () => {
    const everywhere = {
      "5432/tcp": [
        { HostIp: "0.0.0.0", HostPort: "55432" },
        { HostIp: "::", HostPort: "55432" },
      ],
    }
    for (const name of ["playground-db-a1B2", "playground-pg-939-first-run-db-Zz09"]) {
      const docker = scripted([["a"]], [], { a: container(name, everywhere) })
      expect(locate(URL_55432, docker.run).owner.name).toBe(name)
    }
    for (const name of [
      "playground-db",
      "playground-a-db",
      "playground-db-a1B2c",
      "other-db-a1B2",
      "playground-dashboard-db",
    ]) {
      const docker = scripted([["a"]], [], { a: container(name, everywhere) })
      expect(failure(() => locate(URL_55432, docker.run)).failure).toBe("exposed")
    }
  })

  test("any other inspect failure refuses at once, with no re-list", () => {
    let lists = 0
    const run: Docker = (args) => {
      if (args[0] === "ps") return `a${lists++}`
      throw new GuardError(
        "docker-down",
        "docker inspect failed: Cannot connect to the Docker daemon",
      )
    }
    expect(failure(() => locate(URL_55432, run)).failure).toBe("docker-down")
    expect(lists).toBe(1)
  })
})

describe("provenLocal", () => {
  test("a remote URL is refused without a connection", async () => {
    await expect(provenLocal("postgres://u:p@db.example.com:5432/postgres")).rejects.toThrow(
      "not this machine",
    )
  })

  test("the importer's proof re-lists past a vanished container and still refuses an exposed port", async () => {
    const open = container("playground-a-db", {
      "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }],
    })
    const docker = scripted([["checks", "a"], ["a"]], [["checks"]], { a: open })
    await expect(provenLocal(URL_55432, docker.run)).rejects.toThrow("beyond loopback")
    expect(docker.calls).toEqual(["ps", "inspect", "ps", "inspect"])
  })
})
