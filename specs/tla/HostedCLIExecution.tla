------------------------- MODULE HostedCLIExecution -------------------------
(* Execution half of server-hosted-cli.md section 6. Identity and claims *)
(* survive crashes. Docker attachment exit does not imply workload exit. *)
(* Recovery requires the original daemon AND an operator attestation that *)
(* the old executor and outstanding Docker requests can no longer start work. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Commands, MaxConcurrency, MaxFence

VARIABLES jobs, fence, leaseLive, blocked, oldStopped
vars == <<jobs, fence, leaseLive, blocked, oldStopped>>

TypeOK ==
    /\ jobs \in [Commands -> [
        state : {"queued", "active", "terminal"},
        claimed : BOOLEAN, registered : BOOLEAN,
        running : BOOLEAN, observedExit : BOOLEAN, attached : BOOLEAN,
        dispatches : 0..2, owner : 0..MaxFence]]
    /\ fence \in 1..MaxFence
    /\ leaseLive \in BOOLEAN /\ blocked \in BOOLEAN /\ oldStopped \in BOOLEAN

Claimed == {c \in Commands : jobs[c].claimed}
Owns(c) == leaseLive /\ jobs[c].owner = fence
CanStart(c) == Owns(c) \/ (~oldStopped /\ jobs[c].owner < fence)

Init ==
    /\ fence = 1 /\ leaseLive = TRUE /\ blocked = FALSE /\ oldStopped = FALSE
    /\ jobs = [c \in Commands |-> [
        state |-> "queued", claimed |-> FALSE, registered |-> FALSE,
        running |-> FALSE, observedExit |-> TRUE, attached |-> FALSE,
        dispatches |-> 0, owner |-> 0]]

Claim(c) ==
    /\ leaseLive /\ ~blocked
    /\ Cardinality(Claimed) < MaxConcurrency
    /\ jobs[c].state = "queued"
    /\ jobs' = [jobs EXCEPT ![c].claimed = TRUE, ![c].state = "active", ![c].owner = fence]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

Register(c) ==
    /\ Owns(c) /\ ~blocked
    /\ jobs[c].state = "active" /\ ~jobs[c].registered
    /\ jobs' = [jobs EXCEPT ![c].registered = TRUE, ![c].observedExit = FALSE]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

Start(c) ==
    /\ CanStart(c) /\ jobs[c].claimed /\ jobs[c].registered
    /\ ~jobs[c].observedExit /\ jobs[c].dispatches = 0
    /\ jobs' = [jobs EXCEPT ![c].running = TRUE, ![c].attached = TRUE, ![c].dispatches = @ + 1]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

DockerExit(c) ==
    /\ jobs[c].attached
    /\ jobs' = [jobs EXCEPT ![c].attached = FALSE]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

WorkloadExit(c) ==
    /\ jobs[c].running
    /\ jobs' = [jobs EXCEPT ![c].running = FALSE]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

(* Failed inspect/remove leaves every state variable unchanged. Only a *)
(* confirmed exit/absence or successful removal on the original daemon *)
(* may set observedExit. A stopped Docker request cannot later start work. *)
ConfirmStopped(c, sameDaemon) ==
    /\ sameDaemon /\ jobs[c].claimed /\ jobs[c].registered
    /\ (~jobs[c].attached \/ oldStopped)
    /\ jobs' = [jobs EXCEPT ![c].running = IF sameDaemon THEN FALSE ELSE @, ![c].observedExit = TRUE]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

Finish(c) ==
    /\ Owns(c) /\ jobs[c].state = "active"
    /\ jobs' = [jobs EXCEPT ![c].state = "terminal"]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

Settle(c) ==
    /\ Owns(c) /\ ~blocked
    /\ jobs[c].state = "terminal" /\ jobs[c].observedExit
    /\ jobs' = [jobs EXCEPT ![c].claimed = FALSE]
    /\ UNCHANGED <<fence, leaseLive, blocked, oldStopped>>

LoseLease ==
    /\ leaseLive /\ fence < MaxFence
    /\ leaseLive' = FALSE /\ oldStopped' = FALSE
    /\ UNCHANGED <<jobs, fence, blocked>>

AcquireLease ==
    /\ ~leaseLive /\ fence < MaxFence
    /\ fence' = fence + 1 /\ leaseLive' = TRUE
    /\ blocked' = (blocked \/ Claimed # {})
    /\ jobs' = [c \in Commands |-> IF jobs[c].claimed
                  THEN [jobs[c] EXCEPT !.state = "terminal"] ELSE jobs[c]]
    /\ UNCHANGED oldStopped

OperatorConfirmsOldStopped ==
    /\ blocked
    /\ oldStopped' = TRUE
    /\ UNCHANGED <<jobs, fence, leaseLive, blocked>>

Recover ==
    /\ leaseLive /\ blocked /\ oldStopped
    /\ \A c \in Claimed : jobs[c].observedExit
    /\ jobs' = [c \in Commands |-> [jobs[c] EXCEPT !.claimed = FALSE]]
    /\ blocked' = FALSE
    /\ UNCHANGED <<fence, leaseLive, oldStopped>>

Next ==
    \/ \E c \in Commands :
        \/ Claim(c) \/ Register(c) \/ Start(c) \/ DockerExit(c)
        \/ WorkloadExit(c) \/ Finish(c) \/ Settle(c)
        \/ \E sameDaemon \in BOOLEAN : ConfirmStopped(c, sameDaemon)
    \/ LoseLease \/ AcquireLease \/ OperatorConfirmsOldStopped \/ Recover

Spec == Init /\ [][Next]_vars

CapacityHeld == Cardinality(Claimed) <= MaxConcurrency
RunningClaimed == \A c \in Commands : jobs[c].running => jobs[c].claimed /\ jobs[c].registered
UnconfirmedClaimed == \A c \in Commands : ~jobs[c].observedExit => jobs[c].claimed
StoppedEvidence == \A c \in Commands : jobs[c].observedExit => ~jobs[c].running
AtMostOnce == \A c \in Commands : jobs[c].dispatches <= 1
Safety == TypeOK /\ CapacityHeld /\ RunningClaimed /\ UnconfirmedClaimed /\ StoppedEvidence /\ AtMostOnce
=============================================================================
