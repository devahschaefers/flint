import IconRail from './components/sidebar/IconRail'
import SidebarPanel from './components/sidebar/SidebarPanel'
import SmartInboxView from './views/SmartInboxView'
import GroupListView from './views/GroupListView'
import { useAppStore } from './store'

export default function App(): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const railItem = useAppStore((s) => s.railItem)
  const setRailItem = useAppStore((s) => s.setRailItem)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)

  return (
    <div className="flex h-full">
      <div className="shrink-0 bg-[#17181b]">
        <IconRail
          active={railItem}
          onSelect={setRailItem}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      </div>
      <main className="relative flex-1 overflow-hidden">
        {view.name === 'inbox' ? <SmartInboxView /> : <GroupListView category={view.category} />}
      </main>
      <SidebarPanel />
    </div>
  )
}
