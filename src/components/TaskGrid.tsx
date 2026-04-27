import { useEffect, useMemo, useState } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, removeTasks } from '../store'
import type { TaskRecord } from '../types'
import TaskCard from './TaskCard'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      if (!matchStatus) return false
      
      if (!q) return true
      const prompt = (t.prompt || '').toLowerCase()
      const paramStr = JSON.stringify(t.params).toLowerCase()
      return prompt.includes(q) || paramStr.includes(q)
    })
  }, [tasks, searchQuery, filterStatus])

  const filteredTaskIds = useMemo(
    () => new Set(filteredTasks.map((task) => task.id)),
    [filteredTasks],
  )
  const selectedTasks = useMemo(
    () => filteredTasks.filter((task) => selectedIds.has(task.id)),
    [filteredTasks, selectedIds],
  )
  const allFilteredSelected =
    filteredTasks.length > 0 && filteredTasks.every((task) => selectedIds.has(task.id))

  useEffect(() => {
    if (!filteredTasks.length) {
      setSelectMode(false)
    }

    setSelectedIds((prev) => {
      let changed = false
      const next = new Set<string>()

      for (const id of prev) {
        if (filteredTaskIds.has(id)) {
          next.add(id)
        } else {
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [filteredTaskIds, filteredTasks.length])

  const handleDelete = (task: TaskRecord) => {
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  const handleToggleSelect = (taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }

  const handleToggleAll = () => {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        return new Set()
      }

      const next = new Set(prev)
      for (const task of filteredTasks) next.add(task.id)
      return next
    })
  }

  const handleCancelSelection = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const handleBulkDelete = () => {
    if (!selectedTasks.length) return

    const count = selectedTasks.length
    setConfirmDialog({
      title: '批量删除记录',
      message: `确定要删除选中的 ${count} 条记录吗？关联图片资源会在不被其他记录引用时清理。`,
      action: async () => {
        await removeTasks(selectedTasks)
        handleCancelSelection()
      },
    })
  }

  if (!filteredTasks.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {searchQuery ? (
          <p className="text-sm">没有找到匹配的记录</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词开始生成图片</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-gray-900">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {selectMode ? `已选 ${selectedTasks.length} / 当前 ${filteredTasks.length}` : `共 ${filteredTasks.length} 条记录`}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={handleToggleAll}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                {allFilteredSelected ? '取消全选' : '全选当前'}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                disabled={!selectedTasks.length}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                清空选择
              </button>
              <button
                type="button"
                onClick={handleCancelSelection}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={!selectedTasks.length}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                删除所选
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectMode(true)}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              批量删除
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            selectMode={selectMode}
            selected={selectedIds.has(task.id)}
            onToggleSelect={() => handleToggleSelect(task.id)}
            onClick={() => setDetailTaskId(task.id)}
            onReuse={() => reuseConfig(task)}
            onEditOutputs={() => editOutputs(task)}
            onDelete={() => handleDelete(task)}
          />
        ))}
      </div>
    </div>
  )
}
