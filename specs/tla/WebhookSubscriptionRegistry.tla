-------------------- MODULE WebhookSubscriptionRegistry --------------------
EXTENDS Naturals
CONSTANTS MaxVersion, MaxTime, FreshWindow
ASSUME /\ MaxVersion > 1 /\ MaxTime > 0 /\ FreshWindow > 0

VARIABLES version, revision, scanVersion, scanAllowed, active, enrolled,
          private, now, refreshed, job, jobRevision, accepted
vars == <<version, revision, scanVersion, scanAllowed, active, enrolled,
          private, now, refreshed, job, jobRevision, accepted>>

Init ==
    /\ version = 1 /\ revision = 1 /\ scanVersion = 0
    /\ scanAllowed = FALSE /\ active = FALSE
    /\ enrolled = TRUE /\ private = TRUE
    /\ now = 0 /\ refreshed = 0
    /\ job = "absent" /\ jobRevision = 0 /\ accepted = FALSE

Fresh == now < refreshed + FreshWindow
Authorized == active /\ enrolled /\ private /\ Fresh

\* Registry CAS advances even when routing and the queue epoch are unchanged.
UpdateRegistry(a) ==
    /\ version < MaxVersion /\ version' = version + 1
    /\ active' = a
    /\ revision' = IF a = active THEN revision ELSE revision + 1
    /\ job' = IF a # active /\ job \in {"ready", "claimed"}
              THEN "cancelled" ELSE job

BeginScan ==
    /\ scanVersion' = version /\ scanAllowed' = (enrolled /\ private)
    /\ UNCHANGED <<version, revision, active, enrolled, private, now,
                   refreshed, job, jobRevision, accepted>>
Publish ==
    /\ scanVersion = version /\ scanVersion > 0
    /\ UpdateRegistry(scanAllowed /\ enrolled /\ private)
    /\ refreshed' = now
    /\ UNCHANGED <<scanVersion, scanAllowed, enrolled, private, now,
                   jobRevision, accepted>>
\* A hint MUST advance CAS even when the previous inventory was already dirty.
Hint ==
    /\ UpdateRegistry(FALSE)
    /\ UNCHANGED <<scanVersion, scanAllowed, enrolled, private, now,
                   refreshed, jobRevision, accepted>>
Revoke ==
    /\ enrolled /\ enrolled' = FALSE /\ UpdateRegistry(FALSE)
    /\ UNCHANGED <<scanVersion, scanAllowed, private, now, refreshed,
                   jobRevision, accepted>>
\* This is an observed visibility change, not an atomic remote GitHub change.
ObserveVisibility ==
    /\ private' = ~private /\ UpdateRegistry(FALSE)
    /\ UNCHANGED <<scanVersion, scanAllowed, enrolled, now, refreshed,
                   jobRevision, accepted>>
Admit ==
    /\ Authorized /\ job = "absent"
    /\ job' = "ready" /\ jobRevision' = revision
    /\ UNCHANGED <<version, revision, scanVersion, scanAllowed, active,
                   enrolled, private, now, refreshed, accepted>>
Claim ==
    /\ job = "ready" /\ jobRevision = revision /\ job' = "claimed"
    /\ UNCHANGED <<version, revision, scanVersion, scanAllowed, active,
                   enrolled, private, now, refreshed, jobRevision, accepted>>
Reserve ==
    /\ Authorized /\ job = "claimed" /\ jobRevision = revision
    /\ job' = "dispatching"
    /\ UNCHANGED <<version, revision, scanVersion, scanAllowed, active,
                   enrolled, private, now, refreshed, jobRevision, accepted>>
Accept ==
    /\ job = "dispatching" /\ job' = "succeeded" /\ accepted' = TRUE
    /\ UNCHANGED <<version, revision, scanVersion, scanAllowed, active,
                   enrolled, private, now, refreshed, jobRevision>>
Tick ==
    /\ now < MaxTime /\ now' = now + 1
    /\ UNCHANGED <<version, revision, scanVersion, scanAllowed, active,
                   enrolled, private, refreshed, job, jobRevision, accepted>>
Next == BeginScan \/ Publish \/ Hint \/ Revoke \/ ObserveVisibility
        \/ Admit \/ Claim \/ Reserve \/ Accept \/ Tick
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ version \in 1..MaxVersion /\ revision \in 1..MaxVersion
    /\ scanVersion \in 0..MaxVersion /\ scanAllowed \in BOOLEAN
    /\ active \in BOOLEAN /\ enrolled \in BOOLEAN /\ private \in BOOLEAN
    /\ now \in 0..MaxTime /\ refreshed \in 0..MaxTime
    /\ job \in {"absent", "ready", "claimed", "dispatching", "cancelled", "succeeded"}
    /\ jobRevision \in 0..MaxVersion /\ accepted \in BOOLEAN
ScopedActivation == active => enrolled /\ private
NoStalePending == job \in {"ready", "claimed"} => jobRevision = revision
AcceptedNeverRetried == accepted => job = "succeeded"
PublishUsesCurrentCAS ==
    [][(version' > version /\ active' => scanVersion = version)]_vars
ReservationUsesFreshAuthority ==
    [][(job # "dispatching" /\ job' = "dispatching" =>
         Authorized /\ jobRevision = revision)]_vars
=============================================================================
