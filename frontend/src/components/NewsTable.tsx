import { useEffect, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { ExternalLink, FileText } from "lucide-react"

interface NewsItem {
  id: string
  title: string
  originalurl: string
  summary?: string
  created_at: string
}

export default function NewsTable() {
  const [newsItems, setNewsItems] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchNews = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/news')
        if (!response.ok) {
          throw new Error('Failed to fetch news')
        }
        const data = await response.json()
        setNewsItems(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchNews()
  }, [])

  const handleSeeSummary = (id: string, summary?: string) => {
    if (summary) {
      alert(summary)
    } else {
      console.log(`Summary not available for article ${id}`)
    }
  }

  const handleGoToOriginal = (url: string) => {
    window.open(url, '_blank')
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <h1 className="text-3xl font-bold text-center mb-8">AI-Summarized-News</h1>
        <div className="text-center">Loading news...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto py-8">
        <h1 className="text-3xl font-bold text-center mb-8">AI-Summarized-News</h1>
        <div className="text-center text-red-500">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-3xl font-bold text-center mb-8">AI-Summarized-News</h1>
      
      {newsItems.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 text-lg">No news to post</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {newsItems.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.id}</TableCell>
                <TableCell className="max-w-md">{item.title}</TableCell>
                <TableCell className="text-center">
                  <div className="flex gap-2 justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSeeSummary(item.id, item.summary)}
                      className="flex items-center gap-1"
                      disabled={!item.summary}
                    >
                      <FileText className="h-4 w-4" />
                      See Summary
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleGoToOriginal(item.originalurl)}
                      className="flex items-center gap-1"
                      disabled={!item.originalurl}
                    >
                      <ExternalLink className="h-4 w-4" />
                      Go to Original
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}