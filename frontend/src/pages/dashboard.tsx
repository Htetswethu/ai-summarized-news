import { useEffect, useState } from "react"
import { useRouter } from "next/router"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RefreshCw, Activity, Database, FileText, Layers, ArrowLeft } from "lucide-react"

interface CrawledContent {
  id: number
  url: string
  title: string
  content_type: string
  total_tokens: number
  status: string
  created_at: string
  chunks_count: number
  groups_count: number
  pending_groups: number
  summarizing_groups: number
  summarized_groups: number
  failed_groups: number
}

interface ChunkGroup {
  id: number
  crawled_content_id: number
  content_title: string
  content_url: string
  group_index: number
  combined_tokens: number
  status: string
  created_at: string
  updated_at: string
  chunks_in_group: number
}

interface ContentChunk {
  id: number
  crawled_content_id: number
  chunk_index: number
  token_count: number
  chunk_type: string
  created_at: string
  preview: string
}

interface PipelineStats {
  crawled_content: Record<string, number>
  chunks: {
    total_chunks: number
    total_tokens: number
  }
  chunk_groups: Record<string, number>
  summaries: {
    total: number
    recent_24h: number
  }
}

const StatusBadge = ({ status }: { status: string }) => {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-800'
      case 'summarized': return 'bg-green-100 text-green-800'
      case 'chunked': return 'bg-purple-100 text-purple-800'
      case 'failed': return 'bg-red-100 text-red-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
      {status}
    </span>
  )
}

export default function Dashboard() {
  const router = useRouter()
  const [crawledContent, setCrawledContent] = useState<CrawledContent[]>([])
  const [chunkGroups, setChunkGroups] = useState<ChunkGroup[]>([])
  const [selectedContent, setSelectedContent] = useState<number | null>(null)
  const [contentChunks, setContentChunks] = useState<ContentChunk[]>([])
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [activeTab, setActiveTab] = useState<'content' | 'groups' | 'chunks'>('content')
  const [loading, setLoading] = useState(false)

  const fetchData = async () => {
    setLoading(true)
    try {
      const [contentRes, groupsRes, statsRes] = await Promise.all([
        fetch('http://localhost:3001/api/dashboard/crawled-content'),
        fetch('http://localhost:3001/api/dashboard/chunk-groups'),
        fetch('http://localhost:3001/api/dashboard/stats')
      ])

      if (contentRes.ok) {
        const contentData = await contentRes.json()
        setCrawledContent(contentData)
      }

      if (groupsRes.ok) {
        const groupsData = await groupsRes.json()
        setChunkGroups(groupsData)
      }

      if (statsRes.ok) {
        const statsData = await statsRes.json()
        setStats(statsData)
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchContentChunks = async (contentId: number) => {
    try {
      const response = await fetch(`http://localhost:3001/api/dashboard/content-chunks/${contentId}`)
      if (response.ok) {
        const chunks = await response.json()
        setContentChunks(chunks)
        setSelectedContent(contentId)
        setActiveTab('chunks')
      }
    } catch (error) {
      console.error('Error fetching content chunks:', error)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto py-8">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <Button 
            variant="outline" 
            onClick={() => router.push('/')}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to News
          </Button>
          <h1 className="text-3xl font-bold text-gray-900">Pipeline Dashboard</h1>
        </div>
        <Button onClick={fetchData} disabled={loading} className="flex items-center gap-2 text-gray-700">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-2">
              <Database className="h-5 w-5 text-blue-500" />
              <h3 className="font-semibold text-gray-900">Crawled Content</h3>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-700">Pending: {stats.crawled_content.pending || 0}</p>
              <p className="text-sm text-gray-700">Chunked: {stats.crawled_content.chunked || 0}</p>
              <p className="text-sm text-gray-700">Failed: {stats.crawled_content.failed || 0}</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-2">
              <Layers className="h-5 w-5 text-green-500" />
              <h3 className="font-semibold text-gray-900">Chunk Groups</h3>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-700">Pending: {stats.chunk_groups.pending || 0}</p>
              <p className="text-sm text-gray-700">Summarized: {stats.chunk_groups.summarized || 0}</p>
              <p className="text-sm text-gray-700">Failed: {stats.chunk_groups.failed || 0}</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-2">
              <FileText className="h-5 w-5 text-purple-500" />
              <h3 className="font-semibold text-gray-900">Content Chunks</h3>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-700">Total: {stats.chunks.total_chunks}</p>
              <p className="text-sm text-gray-700">Tokens: {stats.chunks.total_tokens.toLocaleString()}</p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-5 w-5 text-orange-500" />
              <h3 className="font-semibold text-gray-900">Summaries</h3>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-gray-700">Total: {stats.summaries.total}</p>
              <p className="text-sm text-gray-700">Recent (24h): {stats.summaries.recent_24h}</p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab('content')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'content' 
                ? 'border-blue-500 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Crawled Content ({crawledContent.length})
          </button>
          <button
            onClick={() => setActiveTab('groups')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'groups' 
                ? 'border-blue-500 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Chunk Groups ({chunkGroups.length})
          </button>
          <button
            onClick={() => setActiveTab('chunks')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'chunks' 
                ? 'border-blue-500 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Content Chunks {selectedContent && `(Content ID: ${selectedContent})`}
          </button>
        </nav>
      </div>

      {/* Content Tables */}
      {activeTab === 'content' && (
        <div className="bg-white  rounded-lg shadow overflow-hidden text-gray-700">
          <Table>
            <TableHeader>
              <TableRow className="border-gray-200">
                <TableHead>ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Groups Progress</TableHead>
                <TableHead>Chunks</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crawledContent.map((content) => (
                <TableRow key={content.id} className="border-gray-200 hover:bg-gray-50">
                  <TableCell className="font-medium">{content.id}</TableCell>
                  <TableCell className="max-w-md truncate" title={content.title}>
                    {content.title}
                  </TableCell>
                  <TableCell>
                    <span className="px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-800">
                      {content.content_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={content.status} />
                  </TableCell>
                  <TableCell>{content.total_tokens?.toLocaleString() || 'N/A'}</TableCell>
                  <TableCell>
                    <div className="text-xs space-y-1">
                      <div className="flex gap-2">
                        <span className="text-yellow-600">P:{content.pending_groups}</span>
                        <span className="text-green-600">✓:{content.summarized_groups}</span>
                        {content.failed_groups > 0 && (
                          <span className="text-red-600">✗:{content.failed_groups}</span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{content.chunks_count}</TableCell>
                  <TableCell className="text-sm text-gray-700">
                    {new Date(content.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fetchContentChunks(content.id)}
                      className="text-white"
                    >
                      View Chunks
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeTab === 'groups' && (
        <div className="bg-white rounded-lg shadow overflow-hidden text-gray-700">
          <Table>
            <TableHeader>
              <TableRow className="border-gray-200">
                <TableHead>Group ID</TableHead>
                <TableHead>Content Title</TableHead>
                <TableHead>Group Index</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Chunks</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chunkGroups.map((group) => (
                <TableRow key={group.id} className="border-gray-200 hover:bg-gray-50">
                  <TableCell className="font-medium">{group.id}</TableCell>
                  <TableCell className="max-w-md truncate" title={group.content_title}>
                    {group.content_title}
                  </TableCell>
                  <TableCell>{group.group_index}</TableCell>
                  <TableCell>
                    <StatusBadge status={group.status} />
                  </TableCell>
                  <TableCell>{group.combined_tokens?.toLocaleString()}</TableCell>
                  <TableCell>{group.chunks_in_group}</TableCell>
                  <TableCell className="text-sm text-gray-700">
                    {new Date(group.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm text-gray-700">
                    {new Date(group.updated_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeTab === 'chunks' && (
        <div className="bg-white rounded-lg shadow overflow-hidden text-gray-700">
          {selectedContent ? (
            <>
              <div className="p-4  bg-gray-50">
                <h3 className="font-semibold text-gray-900">Content Chunks for ID: {selectedContent}</h3>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="border-gray-200">
                    <TableHead>Chunk ID</TableHead>
                    <TableHead>Index</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Preview</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contentChunks.map((chunk) => (
                    <TableRow key={chunk.id} className="border-gray-200 hover:bg-gray-50">
                      <TableCell className="font-medium">{chunk.id}</TableCell>
                      <TableCell>{chunk.chunk_index}</TableCell>
                      <TableCell>
                        <span className="px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-800">
                          {chunk.chunk_type}
                        </span>
                      </TableCell>
                      <TableCell>{chunk.token_count}</TableCell>
                      <TableCell className="max-w-sm truncate text-sm text-gray-700">
                        {chunk.preview}
                      </TableCell>
                      <TableCell className="text-sm text-gray-700">
                        {new Date(chunk.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <div className="p-8 text-center text-gray-700">
              <p>Select a content item from the Crawled Content tab to view its chunks</p>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}