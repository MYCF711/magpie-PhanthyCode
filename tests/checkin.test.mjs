import test from 'node:test'
import assert from 'node:assert/strict'
import { billKey, isPositiveGrant, reconcileCheckin } from '../src/checkin.mjs'

const done = { outcome: 'done', credit: 0, message: '今日已签到' }

test('billKey 依次使用 bill_id、biz_id 和内容指纹', () => {
  assert.equal(billKey({ bill_id: 'bill-1', biz_id: 'biz-1' }), 'bill-1')
  assert.equal(billKey({ biz_id: 'biz-1' }), 'biz-1')
  assert.equal(
    billKey({ created_at: '2026-11-03T08:00:00+08:00', points: 10, event_name: '每日签到' }),
    '2026-11-03T08:00:00+08:00:10:每日签到'
  )
  assert.equal(billKey(null), ':0:')
})

test('isPositiveGrant 只接受归一化后的正积分', () => {
  assert.equal(isPositiveGrant({ points: 1 }), true)
  assert.equal(isPositiveGrant({ points: '10.9' }), true)
  assert.equal(isPositiveGrant({ points: 0 }), false)
  assert.equal(isPositiveGrant({ points: -1 }), false)
  assert.equal(isPositiveGrant({ points: '无效' }), false)
  assert.equal(isPositiveGrant(null), false)
})

test('before 中已有的历史账单不会再次计入', () => {
  const historical = { bill_id: 'old', points: 20, event_name: '历史签到' }
  const current = { bill_id: 'new', points: 10, event_name: '每日签到' }

  const result = reconcileCheckin({ before: [historical], after: [historical, current] })

  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, 10)
  assert.deepEqual(result.names, ['每日签到'])
})

test('after 中重复 ID 只计一次', () => {
  const bill = { bill_id: 'same', points: 10, event_name: '每日签到' }

  const result = reconcileCheckin({ before: [], after: [bill, { ...bill }] })

  assert.equal(result.outcome, 'claimed')
  assert.equal(result.credit, 10)
})

test('before 为 null 或 undefined 时保守返回 done', () => {
  const after = [{ bill_id: 'historical', points: 100 }]

  assert.deepEqual(reconcileCheckin({ before: null, after }), done)
  assert.deepEqual(reconcileCheckin({ before: undefined, after }), done)
})

test('before 缺失时仍报告本次已实际获得的一次性奖励', () => {
  const result = reconcileCheckin({
    before: null,
    after: [{ bill_id: 'historical', points: 100 }],
    extraCredit: 30,
    extraName: '首次登录奖励'
  })

  assert.deepEqual(result, {
    outcome: 'claimed',
    credit: 30,
    message: '首次登录奖励 +30',
    names: ['首次登录奖励']
  })
})

test('多笔新账单求和且事件名去重', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { bill_id: 'a', points: 10, event_name: '每日签到' },
      { bill_id: 'b', points: 15, event_name: '每日签到' },
      { bill_id: 'c', points: 5.9, event_name: '任务奖励' }
    ]
  })

  assert.deepEqual(result, {
    outcome: 'claimed',
    credit: 30,
    message: '每日签到 + 任务奖励 +30',
    names: ['每日签到', '任务奖励']
  })
})

test('一次性奖励未入账时叠加，已由新 reward_grant 入账时不双计', () => {
  const daily = { bill_id: 'daily', points: 10, event_name: '每日签到' }
  const reward = {
    bill_id: 'reward',
    biz_type: 'reward_grant',
    points: 20,
    event_name: '首次登录奖励'
  }

  const added = reconcileCheckin({ before: [], after: [daily], extraCredit: 20, extraName: '首次登录奖励' })
  assert.equal(added.credit, 30)
  assert.deepEqual(added.names, ['每日签到', '首次登录奖励'])

  const notDoubled = reconcileCheckin({
    before: [],
    after: [daily, reward],
    extraCredit: 20,
    extraName: '额外奖励'
  })
  assert.deepEqual(notDoubled, {
    outcome: 'claimed',
    credit: 30,
    message: '每日签到 + 首次登录奖励 +30',
    names: ['每日签到', '首次登录奖励'],
    hasNewRewardBill: true
  })
})

test('没有新增正积分账单时返回 done', () => {
  const existing = { bill_id: 'existing', points: 10, event_name: '每日签到' }

  assert.deepEqual(reconcileCheckin({ before: [existing], after: [existing] }), done)
  assert.deepEqual(reconcileCheckin({ before: [], after: [] }), done)
})

test('零积分、负积分和无效积分均忽略', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { bill_id: 'zero', points: 0 },
      { bill_id: 'negative', points: -10 },
      { bill_id: 'invalid', points: '无效' },
      { bill_id: 'missing' }
    ],
    extraCredit: 0
  })

  assert.deepEqual(result, done)
})

test('pointsOf 与 hasRewardBill 可适配其他账单字段', () => {
  const result = reconcileCheckin({
    before: [],
    after: [
      { id: 'a', amount: 8, kind: 'daily' },
      { id: 'b', amount: 12, kind: 'reward' }
    ],
    keyOf: item => item.id,
    pointsOf: item => item.amount,
    hasRewardBill: item => item.kind === 'reward',
    extraCredit: 12
  })

  assert.equal(result.credit, 20)
  assert.equal(result.hasNewRewardBill, true)
})
