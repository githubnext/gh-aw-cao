--------------------------- MODULE HostedCLIActions ---------------------------
(***************************************************************************)
(* Bounded model of optional hosted CLI actions (specs/server-hosted-cli.md). *)
(*                                                                         *)
(* serve-hosted admits a declared dashboard CLI action only when the       *)
(* operator enabled the mode, the requester is a configured administrator  *)
(* whose interactive OAuth authorization is fresh and carries a verified   *)
(* 2FA or SSO factor, and the requester's own token can write the single   *)
(* target repository. execute-cli rechecks write access with a separate  *)
(* metadata-only token before it issues any work token, then uses a       *)
(* single-use installation token scoped to that repository and revokes    *)
(* it as soon as the command ends. Pre-minted tokens are bounded, scoped, *)
(* minted only for verified writers, and handed out at most once.         *)
(* Cancellation also requires write access to the command's repository.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Users,        \* GitHub identities that can sign in
    Admins,       \* configured CAO_GITHUB_ADMIN_USERS
    Repos,        \* repositories a command may target
    Commands,     \* bounded queue identities
    Tokens,       \* bounded installation-token identities
    MaxPool,      \* --max-pooled-tokens
    MaxAge,       \* CAO_ADMIN_REAUTH_MAX_AGE, in clock ticks
    MaxTime,      \* clock bound for model checking
    Enabled       \* serve-hosted --experimental --hosted-cli-actions

ASSUME
    /\ Admins \subseteq Users
    /\ MaxPool \in Nat /\ MaxAge \in Nat \ {0} /\ MaxTime \in Nat
    /\ Enabled \in BOOLEAN

NoUser == "none"
NoRepo == "none"
NoToken == "none"
NoCommand == "none"

CommandStates == {"absent", "queued", "running", "succeeded", "failed", "canceled"}
Terminal == {"succeeded", "failed", "canceled"}
\* "revoking" models a failed revocation that the broker retries until the
\* token's own expiry; such a token is unreachable by any command.
TokenStates == {"unminted", "pooled", "held", "revoking", "revoked", "expired"}

VARIABLES
    now,          \* abstract wall clock
    session,      \* per-user step-up: interactive authorization time and factor
    canWrite,     \* live repository write permission of each user
    cmd,          \* queued command records
    tok,          \* installation token records
    usedBy        \* history: commands that ever held each token

vars == <<now, session, canWrite, cmd, tok, usedBy>>

TypeOK ==
    /\ now \in 0..MaxTime
    /\ session \in [Users -> [authAt : {-1} \cup (0..MaxTime), assured : BOOLEAN]]
    /\ canWrite \in [Users -> [Repos -> BOOLEAN]]
    /\ cmd \in [Commands -> [state : CommandStates,
                             actor : Users \cup {NoUser},
                             repo : Repos \cup {NoRepo},
                             token : Tokens \cup {NoToken},
                             admittedFresh : BOOLEAN,
                             writeAtAdmission : BOOLEAN,
                             writeAtStart : BOOLEAN,
                             verified : BOOLEAN,
                             cancelWrite : BOOLEAN]]
    /\ tok \in [Tokens -> [state : TokenStates,
                           repo : Repos \cup {NoRepo},
                           holder : Commands \cup {NoCommand},
                           vetted : BOOLEAN]]
    /\ usedBy \in [Tokens -> SUBSET Commands]

Init ==
    /\ now = 0
    /\ session = [u \in Users |-> [authAt |-> -1, assured |-> FALSE]]
    /\ canWrite \in [Users -> [Repos -> BOOLEAN]]
    /\ cmd = [c \in Commands |-> [state |-> "absent", actor |-> NoUser, repo |-> NoRepo,
                                  token |-> NoToken, admittedFresh |-> FALSE,
                                  writeAtAdmission |-> FALSE, writeAtStart |-> FALSE,
                                  verified |-> FALSE, cancelWrite |-> FALSE]]
    /\ tok = [t \in Tokens |-> [state |-> "unminted", repo |-> NoRepo, holder |-> NoCommand,
                                vetted |-> FALSE]]
    /\ usedBy = [t \in Tokens |-> {}]

\* Administrator authority requires a configured login plus a fresh,
\* assured interactive authorization. Refresh and revalidation do not
\* change session[u], so only Login can renew it.
AdminAssured(u) ==
    /\ u \in Admins
    /\ session[u].assured
    /\ session[u].authAt >= 0
    /\ now < session[u].authAt + MaxAge

Usable(t) == tok[t].state \in {"pooled", "held", "revoking"}
Pooled == {t \in Tokens : tok[t].state = "pooled"}

-----------------------------------------------------------------------------
(* Environment *)

Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    \* GitHub expires installation tokens independently of revocation.
    /\ \E expiring \in SUBSET {t \in Tokens : tok[t].state \in {"pooled", "revoking"}} :
         tok' = [t \in Tokens |-> IF t \in expiring
                                   THEN [tok[t] EXCEPT !.state = "expired"]
                                   ELSE tok[t]]
    /\ UNCHANGED <<session, canWrite, cmd, usedBy>>

\* Interactive authorization-code callback. assured is TRUE only when GitHub
\* proved 2FA or an attested SSO organization accepted the fresh token.
Login(u, assured) ==
    /\ session' = [session EXCEPT ![u] = [authAt |-> now, assured |-> assured]]
    /\ UNCHANGED <<now, canWrite, cmd, tok, usedBy>>

Logout(u) ==
    /\ session' = [session EXCEPT ![u] = [authAt |-> -1, assured |-> FALSE]]
    /\ UNCHANGED <<now, canWrite, cmd, tok, usedBy>>

\* Repository administrators may remove a requester's access at any time.
LoseWrite(u, r) ==
    /\ canWrite[u][r]
    /\ canWrite' = [canWrite EXCEPT ![u][r] = FALSE]
    /\ UNCHANGED <<now, session, cmd, tok, usedBy>>

-----------------------------------------------------------------------------
(* serve-hosted admission *)

Admit(u, c, r) ==
    /\ Enabled
    /\ cmd[c].state = "absent"
    /\ AdminAssured(u)
    /\ canWrite[u][r]
    /\ cmd' = [cmd EXCEPT ![c] = [state |-> "queued", actor |-> u, repo |-> r,
                                  token |-> NoToken, admittedFresh |-> AdminAssured(u),
                                  writeAtAdmission |-> canWrite[u][r],
                                  writeAtStart |-> FALSE, verified |-> FALSE,
                                  cancelWrite |-> FALSE]]
    /\ UNCHANGED <<now, session, canWrite, tok, usedBy>>

\* Cancellation is an administrator mutation: it requires step-up and the
\* requester's write access to the command's repository.
Cancel(u, c) ==
    /\ Enabled
    /\ AdminAssured(u)
    /\ cmd[c].state \in {"queued", "running"}
    /\ canWrite[u][cmd[c].repo]
    /\ cmd' = [cmd EXCEPT ![c].state = "canceled", ![c].cancelWrite = canWrite[u][cmd[c].repo]]
    /\ UNCHANGED <<now, session, canWrite, tok, usedBy>>

-----------------------------------------------------------------------------
(* execute-cli token broker and executor *)

\* Prefetch pre-mints a work token only for a queued command whose requester
\* currently has write access, checked with a metadata-only token that is
\* revoked within the step and therefore not modeled as a work token.
Prefetch(t, c) ==
    /\ tok[t].state = "unminted"
    /\ Cardinality(Pooled) < MaxPool
    /\ cmd[c].state = "queued"
    /\ canWrite[cmd[c].actor][cmd[c].repo]
    /\ tok' = [tok EXCEPT ![t] = [state |-> "pooled", repo |-> cmd[c].repo, holder |-> NoCommand,
                                  vetted |-> canWrite[cmd[c].actor][cmd[c].repo]]]
    /\ UNCHANGED <<now, session, canWrite, cmd, usedBy>>

\* Before issuing any work, the executor rechecks the requester's live write
\* permission with a metadata-only token. A command that fails the check never
\* receives a work token.
Verify(c) ==
    /\ cmd[c].state = "queued"
    /\ ~cmd[c].verified
    /\ cmd' = [cmd EXCEPT ![c].state = IF canWrite[cmd[c].actor][cmd[c].repo]
                                       THEN "queued" ELSE "failed",
                          ![c].verified = canWrite[cmd[c].actor][cmd[c].repo],
                          ![c].writeAtStart = canWrite[cmd[c].actor][cmd[c].repo]]
    /\ UNCHANGED <<now, session, canWrite, tok, usedBy>>

\* Acquire takes a pooled token for the same scope or mints one on demand,
\* only after Verify succeeded.
Acquire(c, t) ==
    /\ cmd[c].state = "queued"
    /\ cmd[c].verified
    /\ cmd[c].token = NoToken
    /\ \/ tok[t].state = "pooled" /\ tok[t].repo = cmd[c].repo
       \/ tok[t].state = "unminted"
    /\ tok' = [tok EXCEPT ![t] = [state |-> "held", repo |-> cmd[c].repo, holder |-> c,
                                  vetted |-> IF tok[t].state = "pooled" THEN tok[t].vetted
                                             ELSE cmd[c].verified]]
    /\ cmd' = [cmd EXCEPT ![c].token = t]
    /\ usedBy' = [usedBy EXCEPT ![t] = @ \cup {c}]
    /\ UNCHANGED <<now, session, canWrite>>

Start(c) ==
    /\ cmd[c].state = "queued"
    /\ cmd[c].verified
    /\ cmd[c].token # NoToken
    /\ cmd' = [cmd EXCEPT ![c].state = "running"]
    /\ UNCHANGED <<now, session, canWrite, tok, usedBy>>

Finish(c, outcome) ==
    /\ cmd[c].state = "running"
    /\ outcome \in {"succeeded", "failed"}
    /\ cmd' = [cmd EXCEPT ![c].state = outcome]
    /\ UNCHANGED <<now, session, canWrite, tok, usedBy>>

\* Release follows every terminal outcome. Revocation may fail and is retried.
Release(c, revokedNow) ==
    /\ cmd[c].state \in Terminal
    /\ cmd[c].token # NoToken
    /\ tok[cmd[c].token].state = "held"
    /\ tok' = [tok EXCEPT ![cmd[c].token] = [@ EXCEPT !.state = IF revokedNow THEN "revoked" ELSE "revoking",
                                                      !.holder = NoCommand]]
    /\ UNCHANGED <<now, session, canWrite, cmd, usedBy>>

RetryRevoke(t) ==
    /\ tok[t].state = "revoking"
    /\ tok' = [tok EXCEPT ![t].state = "revoked"]
    /\ UNCHANGED <<now, session, canWrite, cmd, usedBy>>

\* Maintain and Close revoke idle pooled tokens.
RevokeIdle(t) ==
    /\ tok[t].state = "pooled"
    /\ tok' = [tok EXCEPT ![t].state = "revoked"]
    /\ UNCHANGED <<now, session, canWrite, cmd, usedBy>>

Next ==
    \/ Tick
    \/ \E u \in Users : \/ \E a \in BOOLEAN : Login(u, a)
                        \/ Logout(u)
                        \/ \E r \in Repos : LoseWrite(u, r)
    \/ \E u \in Users, c \in Commands, r \in Repos : Admit(u, c, r)
    \/ \E u \in Users, c \in Commands : Cancel(u, c)
    \/ \E t \in Tokens, c \in Commands : Prefetch(t, c)
    \/ \E c \in Commands, t \in Tokens : Acquire(c, t)
    \/ \E c \in Commands : \/ Verify(c)
                           \/ Start(c)
                           \/ \E o \in {"succeeded", "failed"} : Finish(c, o)
                           \/ \E ok \in BOOLEAN : Release(c, ok)
    \/ \E t \in Tokens : RetryRevoke(t) \/ RevokeIdle(t)

Fairness ==
    /\ \A c \in Commands : WF_vars(\E ok \in BOOLEAN : Release(c, ok))
    /\ \A t \in Tokens : WF_vars(RetryRevoke(t))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* With the flag off, nothing is ever admitted.
DisabledAdmitsNothing ==
    ~Enabled => \A c \in Commands : cmd[c].state = "absent"

\* Every admitted command came from a configured administrator with a fresh,
\* assured step-up and write access at admission.
AdmissionAuthorized ==
    \A c \in Commands : cmd[c].state # "absent" =>
        /\ cmd[c].actor \in Admins
        /\ cmd[c].admittedFresh
        /\ cmd[c].writeAtAdmission

\* Nothing runs or succeeds without the executor's live write recheck.
ExecutionRechecked ==
    \A c \in Commands : cmd[c].state \in {"running", "succeeded"} => cmd[c].writeAtStart

\* No work token reaches a command before its requester's write access was
\* verified, and every minted work token was vetted for a verified writer.
WorkTokenOnlyAfterVerification ==
    /\ \A c \in Commands : cmd[c].token # NoToken => cmd[c].verified /\ cmd[c].writeAtStart
    /\ \A t \in Tokens : tok[t].state # "unminted" => tok[t].vetted

\* Only a requester with write access to the repository can cancel.
CancelAuthorized ==
    \A c \in Commands : cmd[c].state = "canceled" => cmd[c].cancelWrite

\* A token is handed to at most one command, ever.
TokenSingleUse ==
    \A t \in Tokens : Cardinality(usedBy[t]) <= 1

\* A command's token is scoped to that command's repository.
TokenScopedToRepository ==
    \A c \in Commands : cmd[c].token # NoToken => tok[cmd[c].token].repo = cmd[c].repo

\* Only the command that acquired a token holds it; pooled tokens have no holder.
HeldOnlyByActiveCommand ==
    \A t \in Tokens :
        /\ tok[t].state = "held" <=> tok[t].holder # NoCommand
        /\ tok[t].holder # NoCommand => cmd[tok[t].holder].token = t

\* Pooled tokens are bounded and were never handed to a command.
PoolBoundedAndUnused ==
    /\ Cardinality(Pooled) <= MaxPool
    /\ \A t \in Pooled : usedBy[t] = {}

\* A released token can never be reacquired.
ReleasedNeverReused ==
    \A t \in Tokens : tok[t].state \in {"revoking", "revoked", "expired"} =>
        \A c \in Commands : cmd[c].token = t => cmd[c].state \in Terminal

Safety ==
    /\ TypeOK
    /\ DisabledAdmitsNothing
    /\ AdmissionAuthorized
    /\ ExecutionRechecked
    /\ WorkTokenOnlyAfterVerification
    /\ CancelAuthorized
    /\ TokenSingleUse
    /\ TokenScopedToRepository
    /\ HeldOnlyByActiveCommand
    /\ PoolBoundedAndUnused
    /\ ReleasedNeverReused

-----------------------------------------------------------------------------
(* Liveness *)

\* Every terminal command's token stops being usable.
TerminalTokenInvalidated ==
    \A c \in Commands, t \in Tokens :
        (cmd[c].state \in Terminal /\ cmd[c].token = t) ~> ~Usable(t)

=============================================================================
