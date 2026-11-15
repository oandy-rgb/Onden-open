# Pinned (was the floating `pg18`): same pgvector 0.8.2 / PG 18 / bookworm the
# stack already runs, but a rebuild can no longer silently jump distro or
# pgvector version. The -bookworm part matters: the PGroonga apt source below
# is the bookworm one, so a base hop to trixie would break the build.
FROM pgvector/pgvector:0.8.2-pg18-bookworm

# PGroonga ships as an apt package, so nothing is compiled here (Apache AGE,
# which needed a source build with the full toolchain, was dropped: no product
# code used it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget ca-certificates \
 && wget -q https://packages.groonga.org/debian/groonga-apt-source-latest-bookworm.deb \
 && apt-get install -y --no-install-recommends ./groonga-apt-source-latest-bookworm.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-18-pgdg-pgroonga \
 && apt-get purge -y wget \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* groonga-apt-source-latest-bookworm.deb
