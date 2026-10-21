--------------------------- MODULE WebhookGateway ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Jobs, Workers, Capacity, MaxTime, MaxGeneration
ASSUME /\ Cardinality(Jobs) >= 2 /\ Cardinality(Workers) >= 2
       /\ Capacity > 0 /\ MaxTime > 0 /\ MaxGeneration > 0

VARIABLES jobs, tickets, alive, now, authority, observed, rateAvailable
vars == <<jobs, tickets, alive, now, authority, observed, rateAvailable>>

Terminal == {"succeeded", "expired", "rejected", "cancelled", "failed", "ambiguous"}
Pending == {"ready", "claimed", "dispatching"}
Empty == [state |-> "absent", owner |-> "none", generation |-> 0,
          lease |-> 0, sent |-> FALSE, accepted |-> FALSE,
          checked |-> FALSE, attempts |-> 0]
Active == {j \in Jobs : jobs[j].state \in Pending}
Authorized == authority = "Granted"
Fenced(j, w, g) ==
    /\ alive[w] /\ jobs[j].owner = w /\ jobs[j].generation = g
    /\ tickets[w][j] = g /\ now < jobs[j].lease
UnchangedEnvironment == UNCHANGED <<tickets, alive, now, authority, observed, rateAvailable>>

Init ==
    /\ jobs = [j \in Jobs |-> Empty]
    /\ tickets = [w \in Workers |-> [j \in Jobs |-> 0]]
    /\ alive = [w \in Workers |-> TRUE]
    /\ now = 0 /\ authority = "Granted" /\ observed = FALSE
    /\ rateAvailable = TRUE

\* Jobs identify stable (delivery, subscription) tuples, NEVER policy revisions.
\* Exact approved revision binding is abstracted by the authorization checks.
\* Admission and its dedup marker are one durable atomic operation.
Admit(j) ==
    /\ jobs[j].state = "absent" /\ now < MaxTime
    /\ (~Authorized \/ Cardinality(Active) < Capacity)
    /\ jobs' = [jobs EXCEPT ![j].state =
                   IF Authorized THEN "ready" ELSE "rejected"]
    /\ UnchangedEnvironment

Claim(j, w) ==
    /\ jobs[j].state = "ready" /\ alive[w] /\ now < MaxTime
    /\ jobs[j].generation < MaxGeneration
    /\ jobs' = [jobs EXCEPT ![j].state = "claimed", ![j].owner = w,
                   ![j].generation = @ + 1, ![j].lease = now + 1,
                   ![j].checked = FALSE]
    /\ tickets' = [tickets EXCEPT ![w][j] = jobs[j].generation + 1]
    /\ UNCHANGED <<alive, now, authority, observed, rateAvailable>>

\* A fresh pre-send check is not atomic with a remote GitHub request.
Check(j, w, g) ==
    /\ jobs[j].state = "claimed" /\ Fenced(j, w, g)
    /\ Authorized /\ ~observed
    /\ jobs' = [jobs EXCEPT ![j].checked = TRUE]
    /\ UnchangedEnvironment

BeginDispatch(j, w, g) ==
    /\ jobs[j].state = "claimed" /\ Fenced(j, w, g)
    /\ jobs[j].checked /\ ~observed /\ rateAvailable /\ now < MaxTime
    /\ jobs' = [jobs EXCEPT ![j].state = "dispatching",
                   ![j].attempts = @ + 1]
    /\ UnchangedEnvironment

\* Safe nonacceptance is explicit; an unknown transport outcome is NOT safe.
Send(j, w, g, accept) ==
    /\ jobs[j].state = "dispatching" /\ ~jobs[j].sent
    /\ Fenced(j, w, g) /\ jobs[j].checked /\ now < MaxTime
    /\ jobs' = [jobs EXCEPT ![j].sent = TRUE, ![j].accepted = accept]
    /\ UnchangedEnvironment

Result(j, w, g, known) ==
    /\ jobs[j].state = "dispatching" /\ jobs[j].sent
    /\ Fenced(j, w, g)
    /\ jobs' = [jobs EXCEPT ![j].state =
          IF ~known THEN "ambiguous"
          ELSE IF jobs[j].accepted THEN "succeeded"
          ELSE IF observed THEN "cancelled"
          ELSE IF jobs[j].attempts < MaxGeneration /\ now < MaxTime /\ ~observed
               THEN "ready" ELSE "failed",
          ![j].sent = IF known /\ ~jobs[j].accepted THEN FALSE ELSE @,
          ![j].checked = FALSE]
    /\ UnchangedEnvironment

\* Recovery never replays a possibly accepted request, even before Send.
Reap(j) ==
    /\ jobs[j].state \in {"claimed", "dispatching"}
    /\ now >= jobs[j].lease
    /\ jobs' = [jobs EXCEPT ![j].state =
          IF jobs[j].state = "dispatching" THEN "ambiguous"
          ELSE IF now = MaxTime THEN "expired"
          ELSE IF jobs[j].generation < MaxGeneration THEN "ready" ELSE "failed",
          ![j].checked = FALSE]
    /\ UnchangedEnvironment

Expire(j) ==
    /\ jobs[j].state = "ready" /\ now = MaxTime
    /\ jobs' = [jobs EXCEPT ![j].state = "expired"]
    /\ UnchangedEnvironment

\* External authority changes precede their local observation.
ChangeAuthority(reason) ==
    /\ Authorized /\ reason \in {"Revoked", "Removed", "Hidden"}
    /\ authority' = reason
    /\ UNCHANGED <<jobs, tickets, alive, now, observed, rateAvailable>>

Observe ==
    /\ ~Authorized /\ ~observed
    /\ observed' = TRUE
    /\ jobs' = [j \in Jobs |->
         IF jobs[j].state \in {"ready", "claimed"}
         THEN [jobs[j] EXCEPT !.state = "cancelled", !.checked = FALSE]
         ELSE jobs[j]]
    /\ UNCHANGED <<tickets, alive, now, authority, rateAvailable>>

Crash(w) ==
    /\ alive[w] /\ alive' = [alive EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<jobs, tickets, now, authority, observed, rateAvailable>>
Restart(w) ==
    /\ ~alive[w] /\ alive' = [alive EXCEPT ![w] = TRUE]
    /\ UNCHANGED <<jobs, tickets, now, authority, observed, rateAvailable>>
Tick ==
    /\ now < MaxTime /\ now' = now + 1
    /\ UNCHANGED <<jobs, tickets, alive, authority, observed, rateAvailable>>
RateChange ==
    /\ rateAvailable' = ~rateAvailable
    /\ UNCHANGED <<jobs, tickets, alive, now, authority, observed>>

\* Duplicate delivery has no effect, including after a terminal outcome.
Duplicate(j) == /\ jobs[j].state # "absent" /\ UNCHANGED vars
Next ==
    \/ \E j \in Jobs : Admit(j) \/ Reap(j) \/ Expire(j) \/ Duplicate(j)
    \/ \E j \in Jobs, w \in Workers : Claim(j, w)
    \/ \E j \in Jobs, w \in Workers, g \in 1..MaxGeneration :
         Check(j, w, g) \/ BeginDispatch(j, w, g)
         \/ (\E accept \in BOOLEAN : Send(j, w, g, accept))
         \/ (\E known \in BOOLEAN : Result(j, w, g, known))
    \/ \E reason \in {"Revoked", "Removed", "Hidden"} : ChangeAuthority(reason)
    \/ Observe
    \/ \E w \in Workers : Crash(w) \/ Restart(w)
    \/ Tick \/ RateChange

Spec == Init /\ [][Next]_vars
LivenessSpec ==
    /\ Spec
    /\ WF_vars(Tick)
    /\ \A j \in Jobs : WF_vars(Reap(j)) /\ WF_vars(Expire(j))
EventualSettlement ==
    \A j \in Jobs : [](jobs[j].state \in Pending =>
                         <>(jobs[j].state \in Terminal))
TypeOK ==
    /\ jobs \in [Jobs -> [state : Pending \cup Terminal \cup {"absent"},
         owner : Workers \cup {"none"}, generation : 0..MaxGeneration,
         lease : 0..MaxTime, sent : BOOLEAN, accepted : BOOLEAN,
         checked : BOOLEAN, attempts : 0..MaxGeneration]]
    /\ tickets \in [Workers -> [Jobs -> 0..MaxGeneration]]
    /\ alive \in [Workers -> BOOLEAN] /\ now \in 0..MaxTime
    /\ authority \in {"Granted", "Revoked", "Removed", "Hidden"}
    /\ observed \in BOOLEAN /\ rateAvailable \in BOOLEAN
BoundedQueue == Cardinality(Active) <= Capacity
AcceptedNeverRetried ==
    \A j \in Jobs : jobs[j].accepted =>
        jobs[j].state \in {"dispatching", "succeeded", "ambiguous"}
SuccessRequiresAcceptance ==
    \A j \in Jobs : jobs[j].state = "succeeded" => jobs[j].accepted
ObservedChangeBlocksNewClaims ==
    observed => \A j \in Jobs :
        jobs[j].state \notin {"ready", "claimed"}
DispatchRequiresCheck ==
    \A j \in Jobs : jobs[j].state = "dispatching" /\ ~jobs[j].sent
        => jobs[j].checked
TerminalStable ==
    [][(\A j \in Jobs : jobs[j].state \in Terminal => jobs'[j] = jobs[j])]_vars
FencedMutations ==
    [][(\A j \in Jobs :
       ((jobs'[j].checked /\ ~jobs[j].checked)
        \/ (jobs'[j].sent /\ ~jobs[j].sent)
        \/ jobs'[j].attempts > jobs[j].attempts
        \/ (jobs'[j].state # jobs[j].state /\
        jobs[j].state \in {"claimed", "dispatching"} /\
        jobs'[j].state \in {"dispatching", "ready", "succeeded"})) =>
          (\E w \in Workers, g \in 1..MaxGeneration : Fenced(j, w, g))
          \/ (jobs[j].state = "claimed" /\ now >= jobs[j].lease))]_vars
GenerationMonotonic ==
    [][(\A j \in Jobs : jobs'[j].generation >= jobs[j].generation)]_vars
NoDispatchReservationAfterObservation ==
    [][(observed => \A j \in Jobs :
        jobs[j].state # "dispatching" => jobs'[j].state # "dispatching")]_vars
=============================================================================
