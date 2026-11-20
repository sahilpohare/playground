import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { machine, runSlot, SCRIPT, spawn } from "./run-slot-fake"

// a check waits on its run's exit or a line it prints, so the timeout only catches a hang
setDefaultTimeout(60_000)

// #1083, 6 Nov 00:38Z: a parallel docker compose build outside run-slot filled the Docker VM the live dashboard's Postgres shares, and got it killed
// A machine whose fake docker reports an 8 GiB VM (`info`, or the memory file's bytes), keeps its capped builder's cap in a marker (`buildx create` writes it, `buildx inspect` reports it, `buildx rm` removes it), lists api and web for `compose config --services`, logs each compose build's services as it starts and ends (a pause between, so two builds at once interleave), and touches its last word for any other call.
const dockerMachine = () => {
  const m = machine()
  const log = join(m.root, "docker.log")
  // every docker call with the builder it runs under, and the marker holding the capped builder's memory cap
  const calls = join(m.root, "docker-calls.log")
  const made = join(m.root, "builder-made")
  const memory = join(m.root, "vm-memory")
  writeFileSync(
    join(m.bin, "docker"),
    `#!/bin/bash
echo "BUILDX_BUILDER=\${BUILDX_BUILDER:-} $*" >> ${calls}
case " $* " in
  *" info "*) [ -f ${memory} ] && cat ${memory} || echo 8391860224; exit 0 ;;
  *" buildx inspect "*) [ -f ${made} ] || exit 1; echo "Driver Options: default-load=\\"true\\" memory=\\"$(cat ${made})\\" memory-swap=\\"$(cat ${made})\\""; exit 0 ;;
  *" buildx create "*) for a; do case "$a" in memory=*) echo "\${a#memory=}" > ${made} ;; esac; done; exit 0 ;;
  *" buildx rm "*) rm -f ${made}; exit 0 ;;
  *" buildx stop "*) exit 0 ;;
  *" config "*"--services "*) printf 'api\\nweb\\n'; exit 0 ;;
  *" compose "*"build "*) while [ "$1" != build ]; do shift; done; shift
    echo "start $*" >> ${log}; sleep 0.3; echo "end $*" >> ${log}; exit 0 ;;
esac
touch "\${@: -1}"
`,
  )
  chmodSync(join(m.bin, "docker"), 0o755)
  const holdDocker = () => m.hold("run-slot-docker", 0, "docker")
  const builds = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])
  // a docker command through run-slot, its stderr read as it comes, as start() reads a run's
  const docker = (who: string, words: string[], flags: string[] = []) => {
    const p = runSlot(["bash", SCRIPT, who, ...flags, "--", ...words], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    let err = ""
    const read = (async () => {
      for await (const chunk of p.stderr) err += new TextDecoder().decode(chunk)
    })()
    const done = async () => {
      const code = await p.exited
      await read
      return { code, err }
    }
    return { done, p, stderr: () => err }
  }
  const dockerCalls = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []
  return { ...m, builds, docker, dockerCalls, holdDocker, made, memory }
}

const CREATE = (cap: string) =>
  `BUILDX_BUILDER= buildx create --name playground-capped --driver docker-container --driver-opt memory=${cap} --driver-opt memory-swap=${cap} --driver-opt default-load=true`

describe("run-slot runs one docker build at a time on the machine (#1083)", () => {
  test("a docker build waits while another holds run-slot-docker, and runs once it is given back", async () => {
    const m = dockerMachine()
    m.holdDocker()
    const run = m.start("worker-d", {}, SCRIPT, ["docker", "build", "."])
    expect(await run.saw(/waiting for run-slot-docker/g)).toBe(true)
    expect(existsSync(run.marker)).toBe(false)
    m.release("run-slot-docker")
    expect(await run.ran()).toBe(true)
    expect(existsSync(join(m.ops, "run-slot-docker"))).toBe(false)
  })

  // #1228: macOS's default disk runs docker by a name in any letter case, so the name reads as docker's
  for (const argv of [
    ["Docker", "build", "."],
    ["nice", "/usr/local/bin/DOCKER", "build", "."],
  ])
    test(`a docker build named in another letter case waits for run-slot-docker: ${argv.join(" ")}`, async () => {
      const m = dockerMachine()
      m.holdDocker()
      const run = m.start("worker-d", {}, SCRIPT, argv)
      expect(await run.saw(/waiting for run-slot-docker/g)).toBe(true)
      m.release("run-slot-docker")
      await run.ran()
    })

  test("a run that builds no image starts beside a held run-slot-docker", async () => {
    const m = dockerMachine()
    m.holdDocker()
    expect(await m.runs("worker-e")).toBe(true)
  })

  test("a docker compose build naming no service builds each service config lists, one after another", async () => {
    const m = dockerMachine()
    const { code, err } = await m
      .docker("worker-d", ["docker", "compose", "build", "--no-cache"])
      .done()
    expect(code).toBe(0)
    expect(m.builds()).toEqual([
      "start --no-cache api",
      "end --no-cache api",
      "start --no-cache web",
      "end --no-cache web",
    ])
    expect(err).toContain("docker-build: building api (1 of 2)")
    expect(err).toContain("docker-build: building web (2 of 2)")
  })

  test("a docker compose build past a project option lists its services with that option, and builds each in turn", async () => {
    const m = dockerMachine()
    expect(
      (await m.docker("worker-d", ["docker", "compose", "build", "--profile", "p"]).done()).code,
    ).toBe(0)
    expect(m.dockerCalls()).toContain(
      "BUILDX_BUILDER=playground-capped compose config --profile p --services",
    )
    expect(m.builds()).toEqual([
      "start --profile p api",
      "end --profile p api",
      "start --profile p web",
      "end --profile p web",
    ])
  })

  test("a docker compose build naming two services builds them one after another", async () => {
    const m = dockerMachine()
    expect(
      (await m.docker("worker-d", ["docker", "compose", "build", "web", "api"]).done()).code,
    ).toBe(0)
    expect(m.builds()).toEqual(["start web", "end web", "start api", "end api"])
  })

  test("a docker compose build naming one service runs as it is", async () => {
    const m = dockerMachine()
    expect((await m.docker("worker-d", ["docker", "compose", "build", "api"]).done()).code).toBe(0)
    expect(m.builds()).toEqual(["start api", "end api"])
  })

  test.each([
    ["docker compose up", ["compose", "up", "-d"], "--no-build"],
    ["docker compose up --build", ["compose", "up", "--build"], "--no-build"],
    ["docker compose watch", ["compose", "watch"], "--no-build"],
    ["docker compose alpha watch", ["compose", "alpha", "watch"], "--no-build"],
    ["docker buildx bake", ["buildx", "bake"], "one run-slot run at a time"],
    ["docker bake", ["bake"], "one run-slot run at a time"],
    ["docker bake of one target", ["bake", "web"], "one run-slot run at a time"],
  ])("%s, which builds its images at once, is refused with the fix", async (_name, words, fix) => {
    const m = dockerMachine()
    const { code, err } = await m.docker("worker-d", ["docker", ...words]).done()
    expect(code).toBe(2)
    expect(err).toContain("run-slot.sh refuses")
    expect(err).toContain(fix)
    expect(m.builds()).toEqual([])
  })

  test("portless's compose up through bunx is refused with the same fix", async () => {
    const m = dockerMachine()
    const p = runSlot(
      ["bash", SCRIPT, "worker-d", "--", "bunx", "portless", "compose", "up", "-d"],
      {
        cwd: m.root,
        env: m.env(),
        stderr: "pipe",
        ops: m.ops,
      },
    )
    expect(await p.exited).toBe(2)
    expect(await new Response(p.stderr).text()).toContain("--no-build")
  })

  test("a chain that builds an image is refused, so each build is a run of its own", async () => {
    const m = dockerMachine()
    const p = runSlot(["bash", SCRIPT, "worker-d", "--", "bash", "-c", "true && docker build ."], {
      cwd: m.root,
      env: m.env(),
      stderr: "pipe",
      ops: m.ops,
    })
    expect(await p.exited).toBe(2)
    expect(await new Response(p.stderr).text()).toContain(
      "refuses a chain that builds a docker image",
    )
  })

  // a script chain_steps cannot read (a raw \x02 to \x07 byte, which it holds quoted globs as, or one shlex cannot split) gave no steps, so its docker step ran past the lane
  describe("a chain run-slot cannot read that names docker is refused", () => {
    const run = async (shell: string, script: string) => {
      const m = dockerMachine()
      const marker = join(m.root, "ran")
      const p = runSlot(["bash", SCRIPT, "worker-d", "--", shell, "-c", script], {
        cwd: m.root,
        env: m.env({ MARKER: marker }),
        stderr: "pipe",
        ops: m.ops,
      })
      return {
        code: await p.exited,
        err: await new Response(p.stderr).text(),
        ran: existsSync(marker),
      }
    }
    const CANNOT = "cannot read this chain's steps, so it refuses one that names docker or portless"

    test("a raw \\x02 byte before a docker build", async () => {
      const r = await run("sh", "echo \x02; docker build .")
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    test("a script shlex cannot split", async () => {
      const r = await run("sh", "echo 'open; docker build .")
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    test("a quoted \\x02 byte before a compose build, under bash", async () => {
      const r = await run("bash", 'echo "\x02" && docker compose build web')
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    // a script file read through `bash <file>`, named so the command's words name docker
    const file = async (args: string[], script: string) => {
      const m = dockerMachine()
      writeFileSync(join(m.root, "docker-steps.sh"), script)
      const p = runSlot(["bash", SCRIPT, "worker-d", "--", "bash", ...args, "docker-steps.sh"], {
        cwd: m.root,
        env: m.env(),
        stderr: "pipe",
        ops: m.ops,
      })
      return { code: await p.exited, err: await new Response(p.stderr).text() }
    }

    test("an option word before a script file", async () => {
      const r = await file(["-x"], "docker build .\n")
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    test("while a script file it reads keeps the chain's refusal", async () => {
      const r = await file([], "echo hi\ndocker build .\n")
      expect(r.code).toBe(2)
      expect(r.err).toContain("refuses a chain that builds a docker image")
    })

    test("while a chain it reads keeps its own refusal", async () => {
      const r = await run("sh", "echo hi; docker build .")
      expect(r.code).toBe(2)
      expect(r.err).toContain("refuses a chain that builds a docker image")
    })

    test("and a \\x02 byte in a chain that names no docker runs as before", async () => {
      const r = await run("sh", 'echo \x02 && touch "$MARKER"')
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })

    test("as does a chain with no such byte", async () => {
      const r = await run("sh", 'echo hi && touch "$MARKER"')
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })
  })

  // chain_steps read only a chain whose first word was sh, bash or zsh, so a chain behind a wrapper word, in another POSIX shell, or built by eval or a variable gave no steps, and its docker build skipped the lane
  describe("a chain behind a wrapper word or in another shell is read for docker", () => {
    const run = async (argv: string[]) => {
      const m = dockerMachine()
      const marker = join(m.root, "ran")
      const p = runSlot(["bash", SCRIPT, "worker-d", "--", ...argv], {
        cwd: m.root,
        env: m.env({ MARKER: marker }),
        stderr: "pipe",
        ops: m.ops,
      })
      const code = await p.exited
      return {
        calls: m.dockerCalls(),
        code,
        err: await new Response(p.stderr).text(),
        ran: existsSync(marker),
      }
    }
    const CHAIN = "refuses a chain that builds a docker image"
    const CANNOT = "cannot read this chain's steps, so it refuses one that names docker or portless"
    const GLOB = "a program word written as a glob or a brace that can expand to docker or podman"

    // #1228: macOS's default disk ignores case, so a docker or chain shell word in any letter case runs that program and reads as its name
    for (const [argv, why] of [
      [["SH", "-c", "docker build ."], CHAIN],
      [["/bin/Bash", "-c", "docker build ."], CHAIN],
      [["sh", "-c", "Docker build ."], CHAIN],
      [["sh", "-c", "true; /usr/local/bin/DOCKER build ."], CHAIN],
      [["sh", "-c", "echo docker build . | SH"], CANNOT],
      [["sh", "-c", "echo $(true); Docker build ."], CHAIN],
      [["sh", "-c", "`echo Docker` build ."], CANNOT],
      [["foo", "SH", "-c", "docker build ."], CANNOT],
      [["arch", "-arm64", "SH", "-c", "docker build ."], CANNOT],
      [["sh", "-c", "NICE /usr/local/bin/doc?er build ."], GLOB],
      [["sh", "-c", "NICE -n 5 /usr/local/bin/doc?er build ."], GLOB],
      [["sh", "-c", "x=docker; NICE $x build ."], CANNOT],
      [["sh", "-c", "Env $X docker build ."], CANNOT],
    ] as const)
      test(`a program word in another letter case: ${argv.join(" ")}`, async () => {
        const r = await run([...argv])
        expect(r.code).toBe(2)
        expect(r.err).toContain(why)
      })

    test("a wrapper with an option value before sh -c", async () => {
      const r = await run(["nice", "-n", "5", "sh", "-c", "docker build ."])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CHAIN)
    })

    test("a wrapper with a positional value before bash -c", async () => {
      const r = await run(["timeout", "600", "bash", "-c", "docker compose build web"])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CHAIN)
    })

    for (const shell of ["dash", "ksh"])
      test(`a ${shell} chain`, async () => {
        const r = await run([shell, "-c", "docker build ."])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CHAIN)
      })

    // review round 1 of #1158: any single-dash cluster holding c gives the shell its script, -ce as well as -c and -ec
    for (const dashC of ["-c", "-ec", "-ce"])
      test(`an unplaced first word before a shell's ${dashC}`, async () => {
        const r = await run(["launcher", "sh", dashC, "docker build ."])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    test("an eval step", async () => {
      const r = await run(["sh", "-c", "eval docker build ."])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    test("a step run through a variable", async () => {
      const r = await run(["sh", "-c", "x=docker; $x build ."])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    // review round 1: a wrapper option's value is never its program, so a docker word there leaves the shell after it to be read
    for (const argv of [
      ["sudo", "-g", "docker", "sh", "-c", "docker build ."],
      ["sudo", "-u", "docker", "bash", "-c", "docker compose build web"],
      ["env", "-u", "docker", "sh", "-c", "docker build ."],
      ["timeout", "-k", "docker", "600", "sh", "-c", "docker build ."],
      ["xargs", "-I", "docker", "sh", "-c", "docker build ."],
    ])
      test(`a docker word as a wrapper option's value: ${argv.slice(0, 3).join(" ")}`, async () => {
        const r = await run(argv)
        expect(r.code).toBe(2)
        expect(r.err).toContain(CHAIN)
      })

    // review round 1: a $ word behind a wrapper word, and a command substitution in any word, name their program only when the shell runs them
    for (const script of [
      "D=docker; command $D build .",
      "D=docker; time $D build .",
      'echo "$(docker build .)"',
      "x=`docker build .`",
      "echo `docker build .`",
      "`echo docker` build .",
    ])
      test(`a step it cannot read: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    // review round 2: a backquote's inner script splits at ;, so its program's name is read over the whole chain and the words before the shell, not its own step's words
    for (const argv of [
      ["sh", "-c", "echo docker; `printf dock; printf er` build ."],
      ["env", "X=docker", "sh", "-c", "`printf dock; printf er` build ."],
    ])
      test(`a substitution whose name sits in another step: ${argv.join(" ")}`, async () => {
        const r = await run(argv)
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    // #1152: a step that runs a chain shell with its own -c script holds a chain this reads only one level of, so it reads as one it cannot read
    for (const script of [
      'echo hi; sh -c "docker build ."',
      'echo hi; D=docker; bash -c "$D build ."',
      'echo hi; nice sh -c "docker build ."',
      'echo hi; sh -ce "docker build ."',
      // review round 1: a chain shell anywhere in the step, behind any program, and one given a $ word, fail closed
      'echo hi; flock /tmp/run.lock sh -c "docker build ."',
      'echo hi; O=-c; sh $O "docker build ."',
    ])
      test(`a nested chain: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    // #1158's review: ksh reads a cluster with a dash inside it as two options (ksh -x-c runs its -c script), and after an unplaced first word a ksh word reads as a chain run-slot cannot read whatever follows it
    test("an unplaced first word before ksh -x-c", async () => {
      const r = await run(["launcher", "ksh", "-x-c", "docker build ."])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    // review round 2 of #1159: a shell word after an unplaced first word runs a script run-slot cannot read whatever follows it, a script file or an option's value as well as a -c cluster
    for (const argv of [
      ["launcher", "bash", "docker-build.sh"],
      ["launcher", "bash", "-O", "extglob", "docker-build.sh"],
    ])
      test(`an unplaced first word before a shell word: ${argv.join(" ")}`, async () => {
        const r = await run(argv)
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    test("a nested ksh -x-c chain", async () => {
      const r = await run(["sh", "-c", 'echo hi; ksh -x-c "docker build ."'])
      expect(r.code).toBe(2)
      expect(r.err).toContain(CANNOT)
    })

    // #1159: a chain shell word anywhere in a step runs a script run-slot does not read, its script fed on stdin through a pipe, a < redirect or a heredoc among them
    for (const script of [
      'echo "docker build ." | sh',
      "bash < docker-build.sh",
      "sh -s < docker-build.sh",
      'printf "docker build .\\n" | nice dash',
      "bash -o pipefail < docker-build.sh",
      "ksh -- < docker-build.sh",
      // review round 1 of #1159: an fd number, an option's value and a heredoc each sit after the shell word, which reads as one run-slot cannot read whatever follows it
      'echo "docker build ." | sh 2>/dev/null',
      'echo "docker build ." | bash 2>&1',
      'echo "docker build ." | dash 1>&2',
      'echo "docker build ." | bash -eo pipefail',
      'echo "docker build ." | bash -O extglob',
      'echo "docker build ." | bash --rcfile /dev/null',
      "sh <<'EOF'\ndocker build .\nEOF",
      'echo hi; sh 2>/dev/null -c "docker build ."',
      "echo hi; bash docker-build.sh",
    ])
      test(`a shell word in a step: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    test("while a stdin-fed shell that names no docker runs as before", async () => {
      const r = await run(["sh", "-c", `echo 'touch "$MARKER"' | sh`])
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })

    // #1209: a program word written as an unquoted glob or brace runs whatever the shell expands it to, so one that can expand to a shell reads as a chain run-slot cannot read
    for (const script of [
      'echo "docker build ." | /bin/s[h]',
      '/bin/s? -c "docker build ."',
      'nice /bin/ba?h -c "docker build ."',
      '/bin/{s,x}h -c "docker build ."',
    ])
      test(`a globbed shell program word: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    // #1209: and one that can expand to docker or podman is refused, though no word names either
    for (const script of [
      "/usr/local/bin/doc?er build .",
      'printf "FROM scratch\\n" | /usr/local/bin/doc*r build -',
      "nice /opt/homebrew/bin/pod[m]an build .",
      "/usr/local/bin/doc{k,}er build .",
    ])
      test(`a globbed docker program word: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(GLOB)
      })

    // #1209: a glob or brace in an argument, or a quoted glob program word, reads as before
    for (const script of [
      'ls doc?er > /dev/null 2>&1; touch "$MARKER"',
      'ls doc{k,}er > /dev/null 2>&1; touch "$MARKER"',
      'echo docker; ls /bin/s[h] > /dev/null; touch "$MARKER"',
      '"/usr/local/bin/doc?er" build . 2> /dev/null; touch "$MARKER"',
      // round 2 of #1209: a case pattern names no program, so `*)` reads as no glob of one
      'case "$1" in a|doc?er) exit 1 ;; *) touch "$MARKER" ;; esac',
      'case x in a) case y in *) :;; esac;; *) touch "$MARKER";; esac',
      // round 3 of #1219: a substitution in single quotes runs nothing, and one whose glob can be no docker or shell reads as before
      "echo '$(/usr/local/bin/doc?er build .)'; touch \"$MARKER\"",
      'echo $(ls /bin/s*.none 2> /dev/null); touch "$MARKER"',
      // round 6 of #1219: a substitution read to the script's end runs as before when no glob in it can be docker or a shell
      'x=$(echo "$(echo a)"); ls /bin/s*.none 2> /dev/null; touch "$MARKER"',
      'x=$(echo ${HOME}); ls *.ts 2> /dev/null; touch "$MARKER"',
      'x=$(git rev-parse "a)b" 2> /dev/null); ls *.ts 2> /dev/null; touch "$MARKER"',
    ])
      test(`while a glob that is no program word runs as before: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(0)
        expect(r.ran).toBe(true)
      })

    // review round 1 of #1209: every step is read for a docker-able program word before an unreadable one ends the read, past a reserved word that leads it, with a bracket class fnmatch does not read failing closed, behind a wrapper's options as wrapper_option reads them, and with [^x] and a letter range expanded
    for (const script of [
      "$X; /usr/local/bin/doc?er build .",
      "echo hi | sh; /usr/local/bin/doc?er build .",
      "/usr/local/bin/doc?er compose run web sh",
      "if true; then /usr/local/bin/doc?er build .; fi",
      "for f in a b; do /usr/local/bin/doc?er build .; done",
      "{ /usr/local/bin/doc?er build .; }",
      "! /usr/local/bin/doc?er build .",
      "/usr/local/bin/[[:lower:]]ocker build .",
      "timeout -s KILL 60 /usr/local/bin/doc?er build .",
      "sudo -u me nice -n 5 /usr/local/bin/doc?er build .",
      "env A=1 /usr/local/bin/doc?er build .",
      "nice --frobnicate /usr/local/bin/doc?er build .",
      "/usr/local/bin/doc[^x]er build .",
      "/usr/local/bin/doc{j..l}er build .",
      "case $1 in a) (/usr/local/bin/doc?er build .) ;; esac",
      "case x in *) /usr/local/bin/d?cker build . ;; esac",
      "case x in a|b) /usr/local/bin/d?cker build . ;; esac",
      "function f { /usr/local/bin/doc?er build .; }; f",
      "coproc /usr/local/bin/doc?er build .",
      // review round 2 of #1219: an arm's command that | ends is no pattern
      "case x in x) true; /usr/local/bin/doc?er build . | cat;; esac",
      "case x in x) cat /dev/null | /usr/local/bin/doc?er build . | cat;; esac",
      "case x in a) echo ;& *) /usr/local/bin/doc?er build . ;; esac",
    ])
      test(`a docker program word in a step: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(GLOB)
      })

    for (const script of [
      "echo docker | ! /bin/s?",
      "echo docker | case x in a|*) /bin/s? ;; esac",
      "case x in x) true; echo docker | /bin/s? | cat;; esac",
      'case x in x) true; sh -c "docker build ." | cat;; esac',
      "case x in x) true; echo docker | sh | cat;; esac",
    ])
      test(`a shell after a reserved word, a case pattern or in a case arm: ${script}`, async () => {
        const r = await run(["sh", "-c", script])
        expect(r.code).toBe(2)
        expect(r.err).toContain(CANNOT)
      })

    // review round 1 of #1209, the lead's ruling: a glob in a script run-slot does not open (a nested -c, one fed on stdin, eval's words, a chain behind an unplaced first word) is read piece by piece as a program word
    for (const argv of [
      ["sh", "-c", 'sh -c "/usr/local/bin/doc?er build ."'],
      ["sh", "-c", 'echo "/usr/local/bin/doc?er build ." | sh'],
      ["sh", "-c", "eval /usr/local/bin/doc?er build ."],
      ["launcher", "sh", "-c", "/usr/local/bin/doc?er build ."],
      ["sh", "-c", "echo /usr/local/bin/doc\\?er build . | sh"],
      ["sh", "-c", "eval /usr/local/bin/doc\\?er build ."],
      // review round 3 of #1219: a command substitution's script, in a case word or pattern or in a word it does not lead
      ["sh", "-c", "case x in $(/usr/local/bin/doc?er build .)) ;; esac"],
      ["sh", "-c", "case $(/usr/local/bin/doc?er build .) in *) ;; esac"],
      ["sh", "-c", "case x in `/usr/local/bin/doc?er build .`) ;; esac"],
      ["sh", "-c", "echo `/usr/local/bin/doc?er build .`"],
      ["sh", "-c", "x=`/usr/local/bin/doc?er build .`"],
      ["sh", "-c", 'echo "$(/usr/local/bin/doc?er build .)"'],
      ["sh", "-c", 'case x in $(/bin/s? -c "/usr/local/bin/doc?er build .")) ;; esac'],
      // review round 4 of #1219: a case inside a substitution closes a pattern with a ) that does not end it
      ["sh", "-c", "case x in $(case y in a) ;; esac; /usr/local/bin/doc?er build .)) ;; esac"],
      ["sh", "-c", "case $(case y in a) ;; esac; /usr/local/bin/doc?er build .) in *) ;; esac"],
      ["sh", "-c", 'echo "$(case y in a) ;; esac; /usr/local/bin/doc?er build .)"'],
      [
        "sh",
        "-c",
        'case x in $(case y in a) ;; esac; /bin/s? -c "/usr/local/bin/doc?er build .")) ;; esac',
      ],
      // review round 5 of #1219: a heredoc body's, a quoted or a comment's ) does not end a substitution
      ["sh", "-c", "case x in $(cat <<E\n)\nE\n/usr/local/bin/doc?er build .)) ;; esac"],
      ["sh", "-c", "case $(cat <<E\n)\nE\n/usr/local/bin/doc?er build .) in *) ;; esac"],
      ["sh", "-c", "case $(cat <<-E\n\t)\n\tE\n/usr/local/bin/doc?er build .) in *) ;; esac"],
      ["sh", "-c", 'echo "$(cat <<E\n)\nE\n/usr/local/bin/doc?er build .)"'],
      [
        "sh",
        "-c",
        'case $(cat <<E\n)\nE\n/bin/s? -c "/usr/local/bin/doc?er build .") in *) ;; esac',
      ],
      ["sh", "-c", "case $(echo ')'; /usr/local/bin/doc?er build .) in *) ;; esac"],
      ["sh", "-c", "case $(: # )\n/usr/local/bin/doc?er build .) in *) ;; esac"],
      ["bash", "-c", 'echo "$(echo ${x%)}; /usr/local/bin/doc?er build .)"'],
      ["bash", "-c", 'echo "$(echo ${x:-)}; /usr/local/bin/doc?er build .)"'],
      ["sh", "-c", "case x in $(f()case y in a) ;; esac; /usr/local/bin/doc?er build .)) ;; esac"],
      ["bash", "-c", "case $(echo $'\\')'\n/usr/local/bin/doc?er build .) in *) ;; esac"],
      ["bash", "-c", "echo $'\\''; case x in $(/usr/local/bin/doc?er build .)) ;; esac"],
      ["bash", "-c", "case x in $(cat <<'E'\n)\nE\n/usr/local/bin/doc?er build .)) ;; esac"],
      ["bash", "-c", "case x in $(cat <<<')'; /usr/local/bin/doc?er build .)) ;; esac"],
      // review round 6 of #1219: a $( or backquote inside a substitution's double quote does not let its ) end the substitution
      ["sh", "-c", 'echo "$(echo "$(echo ")")"; /usr/local/bin/doc?er build .)"'],
      ["sh", "-c", 'echo "$(echo "`echo ")"`"; /usr/local/bin/doc?er build .)"'],
      ["sh", "-c", 'case x in $(echo "$(echo ")")"; /usr/local/bin/doc?er build .)) ;; esac'],
    ])
      test(`a docker glob in a script run-slot does not open: ${argv.join(" ")}`, async () => {
        const r = await run(argv)
        expect(r.code).toBe(2)
        expect(r.err).toContain(GLOB)
      })

    test("while a glob argument behind a wrapper runs as before", async () => {
      const r = await run([
        "sh",
        "-c",
        'nice ls /usr/local/bin/doc?er > /dev/null 2>&1; touch "$MARKER"',
      ])
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })

    test("while a nested chain that names no docker runs as before", async () => {
      const r = await run(["sh", "-c", `echo hi; sh -c 'touch "$MARKER"'`])
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })

    // a command substitution that reads portless's URL starts no container, so it keeps its lane
    test("while a portless URL read in a substitution keeps its lane", async () => {
      const m = dockerMachine()
      const p = runSlot(
        [
          "bash",
          SCRIPT,
          "kind",
          "--",
          "sh",
          "-c",
          'curl -s "$(bunx portless get api.playground)/api/health"',
        ],
        { cwd: m.root, env: m.env(), stdout: "pipe", ops: m.ops },
      )
      expect(await p.exited).toBe(0)
      expect((await new Response(p.stdout).text()).trim()).toBe("")
    })

    test("while a wrapped chain that names no docker runs as before", async () => {
      const r = await run(["nice", "sh", "-c", 'echo hi && touch "$MARKER"'])
      expect(r.code).toBe(0)
      expect(r.ran).toBe(true)
    })

    // the 3 docker runs the runs log held on 3 and 4 Nov, each a container whose own shell runs -c, which is no build on this machine
    for (const argv of [
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "bash:5",
        "bash",
        "-c",
        'echo "$BASH_VERSION"',
      ],
      ["docker", "run", "--rm", "--network", "none", "bash:5", "bash", "-c", "XY=; N=X; echo ok"],
      [
        "docker",
        "run",
        "--rm",
        "-v",
        "/scratch/probe:/m:ro",
        "bash:5",
        "sh",
        "-c",
        "bash sp.sh; bash ansi.sh",
      ],
    ])
      test(`and a docker run whose container shell runs -c passes: ${argv.slice(0, 6).join(" ")}`, async () => {
        const r = await run(argv)
        expect(r.err).not.toContain("refuses")
        expect(r.calls.some((c) => c.includes(" run --rm "))).toBe(true)
      })
  })

  test("a docker build runs in the capped builder, made when missing at half the VM's memory, and stopped after", async () => {
    const m = dockerMachine()
    expect(await m.start("worker-d", {}, SCRIPT, ["docker", "build", "."]).ran()).toBe(true)
    const calls = m.dockerCalls()
    expect(calls[0]).toBe("BUILDX_BUILDER= info --format {{.MemTotal}}")
    expect(calls[1]).toBe("BUILDX_BUILDER= buildx inspect playground-capped")
    // 8391860224 bytes is 8003 MiB, so half is 4001 MiB
    expect(calls[2]).toBe(CREATE("4001m"))
    expect(calls[3]).toStartWith("BUILDX_BUILDER=playground-capped build . ")
    expect(calls[4]).toBe("BUILDX_BUILDER= buildx stop playground-capped")
  })

  test("the cap follows the VM: a 4 GiB VM makes a 2048 MiB builder", async () => {
    const m = dockerMachine()
    writeFileSync(m.memory, "4294967296\n")
    expect(await m.start("worker-d", {}, SCRIPT, ["docker", "build", "."]).ran()).toBe(true)
    expect(m.dockerCalls()).toContain(CREATE("2048m"))
  })

  test("a builder made at another VM's cap is made again at this one's before the build", async () => {
    const m = dockerMachine()
    writeFileSync(m.made, "1536m\n")
    expect(await m.start("worker-d", {}, SCRIPT, ["docker", "build", "."]).ran()).toBe(true)
    const calls = m.dockerCalls()
    const rm = calls.indexOf("BUILDX_BUILDER= buildx rm playground-capped")
    expect(rm).toBeGreaterThan(-1)
    expect(calls.indexOf(CREATE("4001m"))).toBeGreaterThan(rm)
    expect(
      calls.findIndex((call) => call.startsWith("BUILDX_BUILDER=playground-capped build .")),
    ).toBeGreaterThan(rm)
  })

  test("a docker build does not run when the engine reports no memory to cap it by", async () => {
    const m = dockerMachine()
    writeFileSync(m.memory, "\n")
    const run = m.start("worker-d", {}, SCRIPT, ["docker", "build", "."])
    expect(await run.ran()).toBe(false)
    expect(run.p.exitCode).toBe(1)
    expect(m.dockerCalls().some((call) => call.includes(" build ."))).toBe(false)
  })

  test("a compose build's services each build in the capped builder, which is made once", async () => {
    const m = dockerMachine()
    writeFileSync(m.made, "4001m\n")
    expect((await m.docker("worker-d", ["docker", "compose", "build"]).done()).code).toBe(0)
    const builds = m.dockerCalls().filter((call) => call.includes(" build "))
    expect(builds).toEqual([
      "BUILDX_BUILDER=playground-capped compose build api",
      "BUILDX_BUILDER=playground-capped compose build web",
    ])
    expect(m.dockerCalls().some((call) => call.includes("buildx create"))).toBe(false)
  })

  test.each([
    [
      "--builder",
      ["docker", "buildx", "--builder", "default", "build", "."],
      "names its own builder",
    ],
    ["--builder=", ["docker", "build", "--builder=default", "."], "names its own builder"],
    [
      "compose build --builder",
      ["docker", "compose", "build", "--builder", "default"],
      "names its own builder",
    ],
    [
      "BUILDX_BUILDER=",
      ["env", "BUILDX_BUILDER=default", "docker", "build", "."],
      "names its own builder",
    ],
    [
      "env -u BUILDX_BUILDER",
      ["env", "-u", "BUILDX_BUILDER", "docker", "build", "."],
      "names its own builder",
    ],
    [
      "DOCKER_BUILDKIT=0",
      ["env", "DOCKER_BUILDKIT=0", "docker", "build", "."],
      "turns BuildKit off",
    ],
    ["sudo", ["sudo", "docker", "build", "."], "under sudo"],
    ["env -i", ["env", "-i", "docker", "build", "."], "under env -i"],
  ])(
    "a docker build with %s is refused, since it would leave the cap",
    async (_name, words, why) => {
      const m = dockerMachine()
      const { code, err } = await m.docker("worker-d", words).done()
      expect(code).toBe(2)
      expect(err).toContain(why)
      expect(m.dockerCalls()).toEqual([])
    },
  )

  // nice is a binary on the Mac and CI's Linux alike; every wrapper's reading is in tests/packages/scripts/src/docker-build.test.ts
  test("a docker build behind nice takes the lock and the capped builder", async () => {
    const m = dockerMachine()
    m.holdDocker()
    const run = m.start("worker-d", {}, SCRIPT, ["nice", "-n", "5", "docker", "build", "."])
    expect(await run.saw(/waiting for run-slot-docker/g)).toBe(true)
    m.release("run-slot-docker")
    expect(await run.ran()).toBe(true)
    expect(
      m.dockerCalls().some((call) => call.startsWith("BUILDX_BUILDER=playground-capped build .")),
    ).toBe(true)
  })

  test("a compose build behind nice naming no service builds each service in turn", async () => {
    const m = dockerMachine()
    expect((await m.docker("worker-d", ["nice", "docker", "compose", "build"]).done()).code).toBe(0)
    expect(m.builds()).toEqual(["start api", "end api", "start web", "end web"])
  })

  test("a --model-bound docker build is refused, since it would skip run-slot-docker", async () => {
    const m = dockerMachine()
    const { code, err } = await m
      .docker("worker-d", ["docker", "build", "."], ["--model-bound"])
      .done()
    expect(code).toBe(2)
    expect(err).toContain("refuses --model-bound for a docker build")
    expect(m.dockerCalls()).toEqual([])
  })

  test("a docker build reclaims run-slot-docker from a holder whose pid has gone, and runs", async () => {
    const m = dockerMachine()
    m.holdDocker()
    // a pid past any the kernel hands out, so no process holds it
    writeFileSync(
      join(m.ops, "run-slot-docker.holder"),
      "worker-gone 99999999 2026-11-06T01:00:00Z\n",
    )
    expect(await m.start("worker-d", {}, SCRIPT, ["docker", "build", "."]).ran()).toBe(true)
  })

  test("a docker build does not run uncapped when the capped builder cannot be made", async () => {
    const m = dockerMachine()
    writeFileSync(
      join(m.bin, "docker"),
      `#!/bin/bash\necho "$*" >> ${join(m.root, "docker-calls.log")}\ncase " $* " in *" info "*) echo 8391860224; exit 0 ;; *" buildx "*) exit 1 ;; esac\ntouch "\${@: -1}"\n`,
    )
    const run = m.start("worker-d", {}, SCRIPT, ["docker", "build", "."])
    expect(await run.ran()).toBe(false)
    expect(run.p.exitCode).toBe(1)
    expect(m.dockerCalls().some((call) => call.startsWith("build "))).toBe(false)
  })

  test("a docker build that ends gives run-slot-docker back, so the next one starts at once", async () => {
    const m = dockerMachine()
    expect(await m.start("worker-d", {}, SCRIPT, ["docker", "build", "."]).ran()).toBe(true)
    const next = m.start("worker-f", {}, SCRIPT, ["docker", "build", "."])
    expect(await next.ran()).toBe(true)
    expect(next.p.exitCode).toBe(0)
  })

  // #1321: chain_steps read a line's trailing comment with the code, so a quote in one line's comment paired with one in a later line's and the steps between read as one quoted word: a container build on a line between the two ran with no lane at all
  describe("a chain whose comments hold the quotes", () => {
    const run = async (script: string) => {
      const m = dockerMachine()
      const marker = join(m.root, "ran")
      const p = spawn(["bash", SCRIPT, "worker-d", "--", "bash", "-c", script], {
        cwd: m.root,
        env: m.env({ MARKER: marker }),
        stderr: "pipe",
      })
      return {
        code: await p.exited,
        err: await new Response(p.stderr).text(),
        ran: existsSync(marker),
      }
    }

    test("a build on a line between two comment-quote lines is read as a docker step, and the chain is refused", async () => {
      const r = await run('echo one # open "quote\ndocker build .\ntouch $MARKER # close" it')
      expect(r.code).toBe(2)
      expect(r.err).toContain("refuses a chain that builds a docker image")
      expect(r.ran).toBe(false)
    })

    // a continued line's comment and a comment on a line that starts inside a multi-line quote were read with the code, and their quotes paired with a later line's, so the build between them read as no lane again
    test("a build after a continued line whose comment holds a quote is read as a docker step", async () => {
      const r = await run(
        'echo one \\\n  two # open "quote\ndocker build .\necho three # close" it',
      )
      expect(r.code).toBe(2)
      expect(r.err).toContain("refuses a chain that builds a docker image")
      expect(r.ran).toBe(false)
    })

    test("a build after a line that starts inside a quote, with a comment after its close, is read as a docker step", async () => {
      const r = await run(`echo "one\ntwo" # it's open\ndocker build .\necho three # close ' it`)
      expect(r.code).toBe(2)
      expect(r.err).toContain("refuses a chain that builds a docker image")
      expect(r.ran).toBe(false)
    })
  })
})
