import { describe, it, expect, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { isStartableTicket } from './ticketFilter.js'
import { sessions, tickets, createBlankAgent, createAgentFromTicket } from './stores.js'
import type { Ticket } from './types.js'

describe('isStartableTicket', () => {
  it('keeps a backlog ticket (type backlog, done false)', () => {
    expect(isStartableTicket({ done: false, status: { id: '1', name: 'Backlog', type: 'backlog' } })).toBe(true)
  })

  it('keeps a ticket with no status type (done false)', () => {
    expect(isStartableTicket({ done: false, status: undefined })).toBe(true)
  })

  it('keeps a ticket with status type unstarted', () => {
    expect(isStartableTicket({ done: false, status: { id: '2', name: 'Todo', type: 'unstarted' } })).toBe(true)
  })

  it('excludes a ticket with done: true', () => {
    expect(isStartableTicket({ done: true, status: undefined })).toBe(false)
  })

  it('excludes a ticket with status.type === started (In Progress)', () => {
    expect(isStartableTicket({ done: false, status: { id: '3', name: 'In Progress', type: 'started' } })).toBe(false)
  })

  it('excludes a ticket with status.type === canceled', () => {
    expect(isStartableTicket({ done: false, status: { id: '4', name: 'Canceled', type: 'canceled' } })).toBe(false)
  })
})

describe('createBlankAgent', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
  })

  it('returns a tid and adds an idle session to the store', () => {
    const tid = createBlankAgent('Do thing', 'go')
    expect(tid).toMatch(/^TASK-/)
    const all = get(sessions)
    expect(all).toHaveLength(1)
    expect(all[0].tid).toBe(tid)
    expect(all[0].title).toBe('Do thing')
    expect(all[0].status).toBe('idle')
  })

  it('honours an explicit tid when provided', () => {
    const tid = createBlankAgent('X', 'go', 'FLO-9')
    expect(tid).toBe('FLO-9')
    expect(get(sessions)[0].tid).toBe('FLO-9')
  })
})

describe('createAgentFromTicket', () => {
  beforeEach(() => {
    sessions.set([])
    tickets.set([])
  })

  it('returns the ticket tid, seeds a session, and consumes the ticket', () => {
    const t: Ticket = { tid: 'FLO-34', src: 'linear', title: 'Consolidate', repo: '', done: false }
    tickets.set([t])
    const tid = createAgentFromTicket(t, 'Begin implementing FLO-34.')
    expect(tid).toBe('FLO-34')
    expect(get(sessions)[0]).toMatchObject({ tid: 'FLO-34', title: 'Consolidate', status: 'idle' })
    expect(get(tickets)).toHaveLength(0)
  })
})
