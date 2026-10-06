package memory

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type queued struct {
	message operational.TaskMessage
	order   uint64
	created time.Time
	bytes   int64
}

type lease struct {
	consumer string
	at       time.Time
}

type group struct {
	cursor  uint64
	pending map[string]lease
}

type queue struct {
	tasks  []*queued
	groups map[string]*group
}

type scheduled struct {
	task   *queued
	target string
	due    time.Time
}

func copyFields(f operational.TaskFields) operational.TaskFields {
	return operational.TaskFields{Repository: strings.Clone(f.Repository), Task: strings.Clone(f.Task),
		Key: strings.Clone(f.Key), Reason: strings.Clone(f.Reason), RecordedAt: strings.Clone(f.RecordedAt)}
}

func (s *Store) fields(f operational.TaskFields) error {
	if f.Repository == "" && f.Task == "" && f.Key == "" && f.Reason == "" && f.RecordedAt == "" {
		return invalid("task envelope must not be empty")
	}
	total := int64(len(f.Repository)) + int64(len(f.Task)) + int64(len(f.Key)) + int64(len(f.Reason)) + int64(len(f.RecordedAt))
	if total > int64(s.config.MaxRecordBytes) {
		return invalid("task envelope exceeds payload limit")
	}
	return nil
}

func newTask(order uint64, now time.Time, f operational.TaskFields) *queued {
	id := fmt.Sprintf("%d-%d", now.UnixMilli(), order)
	f = copyFields(f)
	return &queued{message: operational.TaskMessage{ID: id, Fields: f}, order: order, created: now,
		bytes: charge(id, f.Repository, f.Task, f.Key, f.Reason, f.RecordedAt)}
}

func (s *Store) planQueue(changes map[recordKey]int64, name string) error {
	if s.queues[name] != nil {
		return nil
	}
	newNames := 0
	for k, size := range changes {
		if k.kind == "queue" || k.kind == "delayed" {
			if _, exists := s.records[k]; !exists && size != 0 {
				newNames++
			} else if exists && size == 0 {
				newNames--
			}
		}
	}
	if len(s.queues)+len(s.delayed)+newNames >= s.config.MaxQueueNames {
		return capacity()
	}
	changes[recordKey{"queue", name, ""}] = charge(name)
	return nil
}

func (s *Store) createQueue(name string) *queue {
	q := s.queues[name]
	if q == nil {
		q = &queue{groups: make(map[string]*group)}
		s.queues[strings.Clone(name)] = q
	}
	return q
}

func (s *Store) EnsureQueue(ctx context.Context, name, consumerGroup string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name, consumerGroup); err != nil {
		return err
	}
	if q := s.queues[name]; q != nil && q.groups[consumerGroup] != nil {
		return nil
	}
	changes := map[recordKey]int64{{"group", name, consumerGroup}: charge(name, consumerGroup)}
	if err := s.planQueue(changes, name); err != nil {
		return err
	}
	if err := s.reserve(changes); err != nil {
		return err
	}
	s.createQueue(name).groups[strings.Clone(consumerGroup)] = &group{pending: make(map[string]lease)}
	return nil
}

func (s *Store) enqueueInput(r operational.EnqueueRequest) error {
	if err := s.name(r.Queue); err != nil {
		return err
	}
	if r.Delayed != "" {
		if err := s.name(r.Delayed); err != nil {
			return err
		}
		if r.Delayed == r.Queue {
			return invalid("ready and delayed queue names must differ")
		}
	}
	if r.Debounce != "" {
		if err := s.name(r.Debounce); err != nil {
			return err
		}
		if err := validTTL(r.DebounceTTL); err != nil {
			return err
		}
	}
	if r.Capacity < 0 {
		return invalid("queue capacity must be non-negative")
	}
	return s.fields(r.Fields)
}

func (s *Store) outstanding(name, delayed string) int64 {
	var n int
	if q := s.queues[name]; q != nil {
		n = len(q.tasks)
	}
	if delayed != "" {
		n += len(s.delayed[delayed])
	} else {
		for _, tasks := range s.delayed {
			for _, task := range tasks {
				if task.target == name {
					n++
				}
			}
		}
	}
	return int64(n)
}

func (s *Store) appendTask(name string, task *queued) {
	q := s.createQueue(name)
	q.tasks = append(q.tasks, task)
	s.taskCount++
	s.taskBytes += task.bytes
}

func (s *Store) enqueue(r operational.EnqueueRequest, delivery string, ttl time.Duration, identity string, now time.Time) (bool, error) {
	if r.Capacity > 0 && s.outstanding(r.Queue, r.Delayed) >= r.Capacity {
		return false, capacity()
	}
	task := newTask(s.seq+1, now, r.Fields)
	if s.taskCount >= s.config.MaxQueuedTasks || task.bytes > s.config.MaxTaskBytes-s.taskBytes {
		return false, capacity()
	}
	changes := map[recordKey]int64{{"task", r.Queue, task.message.ID}: task.bytes + int64(len(r.Queue))}
	if err := s.planQueue(changes, r.Queue); err != nil {
		return false, err
	}
	if r.Debounce != "" {
		changes[recordKey{"debounce", r.Debounce, ""}] = charge(r.Debounce)
	}
	if delivery != "" {
		changes[recordKey{"delivery", delivery, ""}] = charge(delivery)
	}
	if identity != "" {
		changes[recordKey{"identity", r.Queue, identity}] = charge(r.Queue, identity)
	}
	if err := s.reserve(changes); err != nil {
		return false, err
	}
	s.seq++
	s.appendTask(r.Queue, task)
	if r.Debounce != "" {
		s.markers[recordKey{"debounce", strings.Clone(r.Debounce), ""}] = now.Add(r.DebounceTTL)
	}
	if delivery != "" {
		s.markers[recordKey{"delivery", strings.Clone(delivery), ""}] = now.Add(ttl)
	}
	if identity != "" {
		s.identities[recordKey{"identity", strings.Clone(r.Queue), strings.Clone(identity)}] = struct{}{}
	}
	s.notify()
	return true, nil
}

func (s *Store) EnqueueTask(ctx context.Context, r operational.EnqueueRequest) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.enqueueInput(r); err != nil {
		return false, err
	}
	now := s.config.Clock()
	s.prune(now)
	if _, exists := s.markers[recordKey{"debounce", r.Debounce, ""}]; r.Debounce != "" && exists {
		return false, nil
	}
	return s.enqueue(r, "", 0, "", now)
}

func (s *Store) EnqueueUniqueTask(ctx context.Context, name, identity string, limit int64, fields operational.TaskFields) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	r := operational.EnqueueRequest{Queue: name, Capacity: limit, Fields: fields}
	if err := s.enqueueInput(r); err != nil {
		return false, err
	}
	if err := s.name(identity); err != nil {
		return false, err
	}
	key := recordKey{"identity", name, identity}
	if _, exists := s.identities[key]; exists {
		return false, nil
	}
	now := s.config.Clock()
	s.prune(now)
	return s.enqueue(r, "", 0, identity, now)
}

func (s *Store) AdmitDelivery(ctx context.Context, r operational.DeliveryRequest) (operational.DeliveryAdmission, error) {
	if err := s.enter(ctx); err != nil {
		return operational.DeliveryDuplicate, err
	}
	defer s.mu.Unlock()
	if err := s.enqueueInput(r.EnqueueRequest); err != nil {
		return operational.DeliveryDuplicate, err
	}
	if err := s.name(r.Delivery); err != nil {
		return operational.DeliveryDuplicate, err
	}
	if err := validTTL(r.DeliveryTTL); err != nil {
		return operational.DeliveryDuplicate, err
	}
	now := s.config.Clock()
	s.prune(now)
	delivery := recordKey{"delivery", r.Delivery, ""}
	if _, exists := s.markers[delivery]; exists {
		return operational.DeliveryDuplicate, nil
	}
	if _, exists := s.markers[recordKey{"debounce", r.Debounce, ""}]; r.Debounce != "" && exists {
		if err := s.reserve(map[recordKey]int64{delivery: charge(r.Delivery)}); err != nil {
			return operational.DeliveryDuplicate, err
		}
		s.markers[recordKey{"delivery", strings.Clone(r.Delivery), ""}] = now.Add(r.DeliveryTTL)
		return operational.DeliveryCoalesced, nil
	}
	if _, err := s.enqueue(r.EnqueueRequest, r.Delivery, r.DeliveryTTL, "", now); err != nil {
		return operational.DeliveryDuplicate, err
	}
	return operational.DeliveryEnqueued, nil
}

func (s *Store) readInput(r operational.QueueRead) error {
	if err := s.name(r.Queue, r.Group, r.Consumer); err != nil {
		return err
	}
	if r.Count <= 0 || r.Block < 0 {
		return invalid("read count must be positive and block non-negative")
	}
	return nil
}

func leaseKey(name, group, id string) recordKey {
	return recordKey{"lease", name, group + "\x00" + id}
}

func (s *Store) read(r operational.QueueRead, idle *time.Duration) ([]operational.TaskMessage, error) {
	q := s.queues[r.Queue]
	if q == nil || q.groups[r.Group] == nil {
		return nil, fmt.Errorf("queue consumer group not initialized: %w", operational.ErrUnavailable)
	}
	g := q.groups[r.Group]
	now := s.config.Clock()
	tasks := make([]*queued, 0, min(r.Count, len(q.tasks)))
	changes := make(map[recordKey]int64)
	for _, task := range q.tasks {
		if idle == nil {
			if task.order <= g.cursor {
				continue
			}
		} else {
			l, exists := g.pending[task.message.ID]
			if !exists || now.Sub(l.at) < *idle {
				continue
			}
		}
		tasks = append(tasks, task)
		changes[leaseKey(r.Queue, r.Group, task.message.ID)] = charge(r.Queue, r.Group, task.message.ID, r.Consumer)
		if len(tasks) == r.Count {
			break
		}
	}
	if idle == nil && len(tasks) > s.config.MaxLeases-s.leaseCount {
		return nil, capacity()
	}
	if err := s.reserve(changes); err != nil {
		return nil, err
	}
	messages := make([]operational.TaskMessage, 0, len(tasks))
	for _, task := range tasks {
		if idle == nil {
			g.cursor = task.order
			s.leaseCount++
		}
		g.pending[task.message.ID] = lease{strings.Clone(r.Consumer), now}
		messages = append(messages, task.message)
	}
	return messages, nil
}

func (s *Store) ReadTasks(ctx context.Context, r operational.QueueRead) ([]operational.TaskMessage, error) {
	var timer *time.Timer
	for {
		if err := s.enter(ctx); err != nil {
			return nil, err
		}
		if err := s.readInput(r); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		messages, err := s.read(r, nil)
		wake := s.wake
		s.mu.Unlock()
		if err != nil || len(messages) != 0 || r.Block == 0 {
			return messages, err
		}
		if timer == nil {
			timer = time.NewTimer(r.Block)
			defer timer.Stop()
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return []operational.TaskMessage{}, nil
		case <-wake:
		}
	}
}

func (s *Store) ClaimTasks(ctx context.Context, r operational.QueueRead, idle time.Duration) ([]operational.TaskMessage, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	if err := s.readInput(r); err != nil {
		return nil, err
	}
	if idle < 0 {
		return nil, invalid("claim idle duration must be non-negative")
	}
	return s.read(r, &idle)
}

func (s *Store) completedChanges(name string, q *queue, task *queued, changes map[recordKey]int64) {
	changes[recordKey{"task", name, task.message.ID}] = 0
	for group, g := range q.groups {
		if _, exists := g.pending[task.message.ID]; exists {
			changes[leaseKey(name, group, task.message.ID)] = 0
		}
	}
}

func (s *Store) removeTask(name string, q *queue, index int) {
	task := q.tasks[index]
	for group, g := range q.groups {
		if _, exists := g.pending[task.message.ID]; exists {
			delete(g.pending, task.message.ID)
			s.leaseCount--
			s.drop(leaseKey(name, group, task.message.ID))
		}
	}
	copy(q.tasks[index:], q.tasks[index+1:])
	q.tasks[len(q.tasks)-1] = nil
	q.tasks = q.tasks[:len(q.tasks)-1]
	s.drop(recordKey{"task", name, task.message.ID})
	s.taskCount--
	s.taskBytes -= task.bytes
}

func (s *Store) pendingTask(name, group, id string) (*queue, int) {
	q := s.queues[name]
	if q == nil || q.groups[group] == nil {
		return nil, -1
	}
	if _, exists := q.groups[group].pending[id]; !exists {
		return nil, -1
	}
	for index, task := range q.tasks {
		if task.message.ID == id {
			return q, index
		}
	}
	return nil, -1
}

func (s *Store) CompleteTask(ctx context.Context, name, group, id string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name, group, id); err != nil {
		return err
	}
	if q, index := s.pendingTask(name, group, id); q != nil {
		s.removeTask(name, q, index)
	}
	return nil
}

func (s *Store) ReplaceTask(ctx context.Context, r operational.Replacement) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(r.Source, r.Group, r.ID); err != nil {
		return err
	}
	if err := s.fields(r.Fields); err != nil {
		return err
	}
	if r.Capacity < 0 {
		return invalid("replacement capacity must be non-negative")
	}
	destination := r.Destination
	if !r.Due.IsZero() && destination == "" {
		destination = r.Source
	}
	if err := s.name(destination); err != nil {
		return err
	}
	if !r.Due.IsZero() {
		if err := s.name(r.Delayed); err != nil {
			return err
		}
		if r.Delayed == destination {
			return invalid("ready and delayed names must differ")
		}
	}
	q, index := s.pendingTask(r.Source, r.Group, r.ID)
	if q == nil {
		return nil
	}
	old := q.tasks[index]
	count := s.outstanding(destination, r.Delayed)
	if r.Source == destination {
		count--
	}
	if r.Capacity > 0 && count >= r.Capacity {
		return capacity()
	}
	now := s.config.Clock()
	task := newTask(s.seq+1, now, r.Fields)
	if task.bytes-old.bytes > s.config.MaxTaskBytes-s.taskBytes {
		return capacity()
	}
	changes := make(map[recordKey]int64)
	s.completedChanges(r.Source, q, old, changes)
	if r.Due.IsZero() {
		if err := s.planQueue(changes, destination); err != nil {
			return err
		}
		changes[recordKey{"task", destination, task.message.ID}] = task.bytes + int64(len(destination))
	} else {
		if _, exists := s.delayed[r.Delayed]; !exists {
			if len(s.queues)+len(s.delayed) >= s.config.MaxQueueNames {
				return capacity()
			}
			changes[recordKey{"delayed", r.Delayed, ""}] = charge(r.Delayed)
		}
		changes[recordKey{"scheduled", r.Delayed, task.message.ID}] = task.bytes + int64(len(r.Delayed)+len(destination))
	}
	if err := s.reserve(changes); err != nil {
		return err
	}
	s.removeTask(r.Source, q, index)
	s.seq++
	if r.Due.IsZero() {
		s.appendTask(destination, task)
		s.notify()
	} else {
		due := r.Due.Truncate(time.Millisecond)
		if due.Before(r.Due) {
			due = due.Add(time.Millisecond)
		}
		scheduledTasks := s.delayed[r.Delayed]
		scheduledTasks = append(scheduledTasks, scheduled{task: task, target: strings.Clone(destination), due: due})
		s.delayed[strings.Clone(r.Delayed)] = scheduledTasks
		s.taskCount++
		s.taskBytes += task.bytes
	}
	return nil
}

func (s *Store) PromoteTasks(ctx context.Context, delayed, name string, at time.Time, count int) (int64, error) {
	if err := s.enter(ctx); err != nil {
		return 0, err
	}
	defer s.mu.Unlock()
	if err := s.name(delayed, name); err != nil {
		return 0, err
	}
	if count <= 0 || at.IsZero() || delayed == name {
		return 0, invalid("invalid promotion count, time, or names")
	}
	now := s.config.Clock()
	at = at.Truncate(time.Millisecond)
	tasks := s.delayed[delayed]
	due := make([]scheduled, 0, min(count, len(tasks)))
	for _, task := range tasks {
		if task.target == name && !task.due.After(at) {
			due = append(due, task)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		if due[i].due.Equal(due[j].due) {
			return due[i].task.order < due[j].task.order
		}
		return due[i].due.Before(due[j].due)
	})
	if len(due) > count {
		due = due[:count]
	}
	if len(due) == 0 {
		return 0, nil
	}
	changes := make(map[recordKey]int64)
	if len(due) == len(tasks) {
		changes[recordKey{"delayed", delayed, ""}] = 0
	}
	if err := s.planQueue(changes, name); err != nil {
		return 0, err
	}
	remove := make(map[string]struct{}, len(due))
	ready := make([]*queued, 0, len(due))
	var delta int64
	for i, task := range due {
		next := newTask(s.seq+uint64(i)+1, now, task.task.message.Fields)
		ready = append(ready, next)
		changes[recordKey{"scheduled", delayed, task.task.message.ID}] = 0
		changes[recordKey{"task", name, next.message.ID}] = next.bytes + int64(len(name))
		remove[task.task.message.ID] = struct{}{}
		delta += next.bytes - task.task.bytes
	}
	if delta > s.config.MaxTaskBytes-s.taskBytes {
		return 0, capacity()
	}
	if len(remove) == len(tasks) {
		changes[recordKey{"delayed", delayed, ""}] = 0
	}
	if err := s.reserve(changes); err != nil {
		return 0, err
	}
	retained := tasks[:0]
	for _, task := range tasks {
		if _, exists := remove[task.task.message.ID]; exists {
			s.taskCount--
			s.taskBytes -= task.task.bytes
		} else {
			retained = append(retained, task)
		}
	}
	clear(tasks[len(retained):])
	if len(retained) == 0 {
		delete(s.delayed, delayed)
	} else {
		s.delayed[delayed] = retained
	}
	for _, task := range ready {
		s.appendTask(name, task)
	}
	s.seq += uint64(len(ready))
	s.notify()
	return int64(len(ready)), nil
}

func (s *Store) DelayedDepth(ctx context.Context, name string) (int64, error) {
	if err := s.enter(ctx); err != nil {
		return 0, err
	}
	defer s.mu.Unlock()
	if err := s.name(name); err != nil {
		return 0, err
	}
	return int64(len(s.delayed[name])), nil
}

// Length counts ready plus leased stream entries; Backlog excludes leases and
// delayed work. Consumers add DelayedDepth to Backlog when reporting depth.
func (s *Store) QueueStats(ctx context.Context, name, group string) (operational.QueueStats, error) {
	if err := s.enter(ctx); err != nil {
		return operational.QueueStats{}, err
	}
	defer s.mu.Unlock()
	if err := s.name(name); err != nil {
		return operational.QueueStats{}, err
	}
	if group != "" {
		if err := s.name(group); err != nil {
			return operational.QueueStats{}, err
		}
	}
	q := s.queues[name]
	if q == nil {
		return operational.QueueStats{}, nil
	}
	st := operational.QueueStats{Length: int64(len(q.tasks))}
	if group == "" {
		return st, nil
	}
	g := q.groups[group]
	if g == nil {
		st.Backlog = st.Length
		return st, nil
	}
	now := s.config.Clock()
	for _, task := range q.tasks {
		if task.order > g.cursor {
			st.Backlog++
		}
		if _, exists := g.pending[task.message.ID]; exists {
			st.Pending++
			st.OldestPendingAge = max(st.OldestPendingAge, now.Sub(task.created))
		}
	}
	return st, nil
}
