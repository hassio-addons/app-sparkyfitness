# Upgrading the PostgreSQL major version

Notes for whoever changes the PostgreSQL version in the `Dockerfile`. This is
not user documentation; it is the procedure that has to exist before that pin
is touched.

## The constraint

PostgreSQL cannot read a data directory written by a different major version of
itself. `/data/postgres` belongs to whichever major created it, and a new major
will refuse to start on it. There is no in-place conversion: the data has to be
moved from one cluster to another, by `pg_upgrade` or by a dump and restore.

Minor versions are not affected. 18.6 to 18.7 is an ordinary package update
and needs nothing from this document.

## What is already in place

Three decisions were made up front so this upgrade stays possible.

- **The major version is in the package name.** Alpine packages every
  PostgreSQL major separately, as `postgresql18`, `postgresql19` and so on, and
  installs each below a directory of its own, `/usr/libexec/postgresql18`. A
  newer Alpine in the base image therefore never changes the major as a side
  effect; it only changes when someone edits the `Dockerfile`. It also means
  two majors can be installed side by side, which is what `pg_upgrade` needs.
  Alpine only carries a few majors per release, so a base image update will
  eventually force this upgrade, but it cannot happen by accident.

- **`init-sparkyfitness` refuses to start on a mismatch.** It compares
  `/data/postgres/PG_VERSION` against the installed major, read off
  `/usr/libexec/` rather than written down, and stops with an explanation.
  That turns a silent breakage into a loud one, and it is what makes it safe to
  ship a new major without the upgrade being ready in the same release.

- **`initdb` pins every setting `pg_upgrade` compares.** That is
  `--encoding=UTF8`, `--locale=C`, `--locale-provider=builtin`,
  `--builtin-locale=C.UTF-8` and `--data-checksums`. `pg_upgrade` refuses to
  run when the old and the new cluster disagree on any of them. Collation comes
  from PostgreSQL's builtin provider rather than from musl, so it cannot shift
  under the indexes with a base image update either.

Read that last point twice before creating the new cluster. Every flag above
has to be repeated exactly, or `pg_upgrade --check` fails and the release is
dead on arrival.

## The shape of the release

Three releases, not one.

| release    | ships           | on start                        |
| ---------- | --------------- | ------------------------------- |
| now        | OLD only        | refuse anything that is not OLD |
| transition | OLD **and** NEW | upgrade OLD to NEW, then run    |
| later      | NEW only        | refuse anything that is not NEW |

The transition release installs both packages, which costs the size of one more
PostgreSQL in the image. **Keep it for a long window, months of releases rather
than one.** Anybody who updates straight from the first row to the third has a
data directory nothing in the image can read, and their only way out is
restoring a backup. The image size is worth not stranding them.

Mind that `init-sparkyfitness` picks the highest installed major as the one to
run. In the transition release that is NEW, which is what should run once the
upgrade is done.

## The procedure

Add an `init-postgres-upgrade` oneshot between `init-sparkyfitness` and
`postgres`, running only when `/data/postgres/PG_VERSION` is the old major.
Everything below runs as the `postgres` user, with no server running.

1. **Refuse to guess.** If `PG_VERSION` is neither the old nor the new major,
   stop. Only the one step this release knows about is supported.

1. **Check the free space.** Copy mode needs roughly the size of the database
   again. Compare `du -sb /data/postgres` against what is free on `/data` and
   stop with a clear message if it will not fit, rather than filling the disk
   and failing halfway.

1. **Create the new cluster** at `/data/postgres-NEW`, with the identical flags
   listed above.

1. **Dry run first.**

   ```sh
   /usr/libexec/postgresqlNEW/pg_upgrade \
       --old-datadir=/data/postgres \
       --new-datadir=/data/postgres-NEW \
       --old-bindir=/usr/libexec/postgresqlOLD \
       --new-bindir=/usr/libexec/postgresqlNEW \
       --check
   ```

   `--check` touches nothing. If it fails, delete `/data/postgres-NEW`, leave
   the old cluster alone and stop. The installation is still working and the
   user can roll back.

1. **Run it for real**, same command without `--check`. Do it from a writable
   working directory, because `pg_upgrade` writes its log and its generated
   scripts into the current directory. Use copy mode, which is the default.
   `--link` is faster and needs no extra space, but it leaves the old cluster
   unusable whether it succeeds or fails, so there is nothing to roll back to.
   Not worth it here.

1. **Swap the directories** only after it exits zero: move `/data/postgres` to
   `/data/postgres-OLD`, then `/data/postgres-NEW` to `/data/postgres`. Do it
   in that order, so a crash between the two leaves something recoverable
   rather than nothing.

1. **Rebuild the statistics.** `pg_upgrade` does not carry them over, and
   without this the first diary page after the upgrade is slow enough that
   somebody opens an issue about it.

   ```sh
   /usr/libexec/postgresqlNEW/vacuumdb --all --analyze-in-stages \
       -h /run/postgresql
   ```

   This needs the new server running, so it belongs after `postgres` has
   started, not in the oneshot.

1. **Keep `/data/postgres-OLD`** until the release after next, then delete it
   in an init step. Deleting it in the same release that created it removes the
   only cheap way back.

## If `pg_upgrade` turns out to be a fight

Dump and restore is slower and needs the old server briefly running, but it
cares about far less and copes with much larger version gaps:

```sh
# with the OLD server running
/usr/libexec/postgresqlOLD/pg_dumpall -h /run/postgresql > /data/dump.sql
# then, against the freshly created NEW cluster
/usr/libexec/postgresqlNEW/psql -h /run/postgresql -d postgres \
    -f /data/dump.sql
```

For the size of database this app produces, that is minutes, not hours. It is a
perfectly reasonable fallback if `--check` keeps finding objections.

## Things that will bite

- **The guard has to be taught about the transition.** As written,
  `init-sparkyfitness` refuses to start on any mismatch, which includes the one
  the transition release is meant to handle. Loosen it there to allow exactly
  the old major, and tighten it again in the release after.

- **`pg_upgrade` will not run as root.** It refuses, deliberately. Everything
  goes through `s6-setuidgid postgres`, and `/data/postgres-NEW` has to be
  owned by `postgres` with mode `700` before `initdb` touches it.

- **Both clusters must be stopped.** The oneshot runs before the `postgres`
  service by dependency order; do not add a dependency that inverts that.

- **The client tools have to keep up.** SparkyFitness makes its own backups
  with `pg_dump`, which refuses to dump a server newer than itself. Ship the
  `postgresqlNEW-client` package along with the server.

- **Tell users to back up in the release notes.** The app is `backup: cold`, so
  a Home Assistant backup of it is consistent and is the real safety net here.
  The upgrade is careful, but a database conversion is a database conversion.

- **Test with a real database, not an empty one.** Log a few weeks of meals,
  exercise and measurements first. An empty cluster upgrades cleanly no matter
  what is wrong with the procedure.
