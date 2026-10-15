-- Hand-written for the same reason every migration since
-- 20260827010000_payment_void_kind has been: `prisma migrate dev` still
-- refuses against the shared dev database over checksum drift on
-- 20260820010000_chunk2_station_attendance and offers only a reset.
--
-- The Notifications panel (Figure 22, REQ021) has two columns and only ONE of
-- them is stored. Expiration alerts are DERIVED from the same
-- `expiringWithinDays` query the Subscriptions screen already runs — storing
-- them would leave a stale "expiring" row behind every renewal, and would need
-- a nightly sweep just to stay honest. This table is the other column: things
-- the system raised that a person has to look at.

CREATE TYPE "SystemNotificationKind" AS ENUM (
  'LEAD_RECEIVED',
  'NIGHTLY_JOB',
  'NIGHTLY_JOB_FAILED'
);

CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "SystemNotification" (
  -- No database default: Prisma's @default(uuid()) mints it client-side, the
  -- same as every other table here.
  "id"           UUID                     NOT NULL,
  "kind"         "SystemNotificationKind" NOT NULL,
  "severity"     "NotificationSeverity"   NOT NULL DEFAULT 'INFO',
  "title"        TEXT                     NOT NULL,
  "body"         TEXT,
  "linkPath"     TEXT,
  "subjectType"  TEXT,
  "subjectId"    UUID,
  "readAt"       TIMESTAMPTZ(3),
  "readById"     UUID,
  "resolvedAt"   TIMESTAMPTZ(3),
  "resolvedById" UUID,
  "createdAt"    TIMESTAMPTZ(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SystemNotification_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_readById_fkey"
  FOREIGN KEY ("readById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- An actor without an instant, or an instant without an actor, is a row that
-- cannot answer "who marked this and when" — which is the only reason either
-- column exists. Enforced here rather than in the service so a future producer
-- cannot quietly write half a fact.
--
-- Both are biconditionals. Note the direction that is NOT constrained: a row
-- may be resolved without ever being read. Somebody who acts on a notification
-- straight from the list has dealt with it, and demanding a separate "read"
-- first would be bookkeeping for its own sake.
ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_read_shape" CHECK (
    ("readAt" IS NULL) = ("readById" IS NULL)
  );

ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_resolved_shape" CHECK (
    ("resolvedAt" IS NULL) = ("resolvedById" IS NULL)
  );

-- A blank title renders as an empty row that looks like a broken screen.
ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_title_present" CHECK (length(btrim("title")) > 0);

-- `linkPath` is rendered as a link. An absolute URL here would be an open
-- redirect the moment anything trusted the column, and a protocol-relative
-- `//evil.example` is the form that slips past a naive "starts with /" check —
-- the same class of bug `safeNext` exists for on the client.
ALTER TABLE "SystemNotification"
  ADD CONSTRAINT "SystemNotification_link_is_internal" CHECK (
    "linkPath" IS NULL
    OR (
      "linkPath" LIKE '/%'
      AND "linkPath" NOT LIKE '//%'
      -- No backslash. A backslash is what browsers normalise into a
      -- protocol-relative URL, which is how `/\evil.example` escapes a naive
      -- "starts with a slash" check — `safeNext` on the client rejects the
      -- same character for the same reason.
      --
      -- `chr(92)` rather than a quoted backslash: inside a LIKE pattern the
      -- backslash is the escape character, so `NOT LIKE '%\%'` quietly reads
      -- as "no literal percent sign" and lets every backslash through. Naming
      -- the code point leaves nothing for a LIKE parser, a shell, or a future
      -- editor to reinterpret.
      AND strpos("linkPath", chr(92)) = 0
    )
  );

-- The panel's exact query: unresolved first, newest first.
CREATE INDEX "SystemNotification_resolvedAt_createdAt_idx"
  ON "SystemNotification" ("resolvedAt", "createdAt" DESC);

-- The unread badge's count.
CREATE INDEX "SystemNotification_readAt_idx" ON "SystemNotification" ("readAt");

-- "Have we already raised this?" — de-duplication by producer.
CREATE INDEX "SystemNotification_subjectType_subjectId_idx"
  ON "SystemNotification" ("subjectType", "subjectId");
