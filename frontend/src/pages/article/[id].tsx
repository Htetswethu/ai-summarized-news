import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowLeft, ExternalLink, Calendar, Tag, Heart, AlertCircle, Smile } from 'lucide-react'

interface ArticleDetails {
  id: string
  title: string
  originalurl: string
  summary: string
  key_points?: string[]
  content_type?: string
  sentiment?: string
  category?: string
  created_at: string
}

export default function ArticleDetailsPage() {
  const router = useRouter()
  const { id } = router.query
  const [article, setArticle] = useState<ArticleDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Helper function to clean and parse summary content
  const parseContent = (summary: string): { summary: string; keyPoints: string[] } => {
    // Remove JSON code blocks (```json ... ```)
    const cleanedSummary = summary.replace(/```json\s*|\s*```/g, '').trim()
    
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(cleanedSummary)
      if (parsed.summary && parsed.keyPoints) {
        return {
          summary: parsed.summary,
          keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : []
        }
      }
    } catch (e) {
      // If JSON parsing fails, check if it looks like a JSON object and extract manually
      const jsonMatch = cleanedSummary.match(/"summary"\s*:\s*"([^"]+)"/)?.[1]
      const keyPointsMatch = cleanedSummary.match(/"keyPoints"\s*:\s*\[(.*?)\]/)?.[1]
      
      if (jsonMatch) {
        const keyPoints = keyPointsMatch 
          ? keyPointsMatch.split(',').map(point => point.replace(/"/g, '').trim()).filter(Boolean)
          : []
        
        return {
          summary: jsonMatch,
          keyPoints
        }
      }
    }
    
    // Fallback: treat entire content as summary
    return {
      summary: cleanedSummary,
      keyPoints: []
    }
  }

  useEffect(() => {
    if (!id) return

    const fetchArticle = async () => {
      try {
        const response = await fetch(`http://localhost:3001/api/news/${id}`)
        if (!response.ok) {
          throw new Error('Failed to fetch article details')
        }
        const data = await response.json()
        setArticle(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchArticle()
  }, [id])

  if (loading) {
    return (
      <div className="container mx-auto py-8 max-w-4xl">
        <div className="text-center">Loading article details...</div>
      </div>
    )
  }

  if (error || !article) {
    return (
      <div className="container mx-auto py-8 max-w-4xl">
        <div className="text-center text-red-500">
          <AlertCircle className="h-8 w-8 mx-auto mb-2" />
          Error: {error || 'Article not found'}
        </div>
        <div className="text-center mt-4">
          <Link href="/">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to News
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div className="container mx-auto py-8 max-w-4xl">
      {/* Header with back button */}
      <div className="mb-6">
        <Link href="/">
          <Button variant="outline" className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to News
          </Button>
        </Link>
      </div>

      {/* Article content */}
      <article className="bg-white rounded-lg shadow-sm border p-6">
        {/* Title */}
        <h1 className="text-3xl font-bold text-gray-900 mb-4 leading-tight">
          {article.title}
        </h1>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600 mb-6 pb-4 border-b">
          <div className="flex items-center gap-1">
            <Calendar className="h-4 w-4" />
            <span>{formatDate(article.created_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Tag className="h-4 w-4" />
            <span>Article #{article.id}</span>
          </div>
        </div>

        {/* Summary content */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center gap-2">
            <Smile className="h-5 w-5 text-blue-600" />
            AI Summary (Myanmar/Burmese)
          </h2>
          
          {(() => {
            // Parse the content from either summary field or key_points
            let parsedContent = { summary: '', keyPoints: [] as string[] };
            
            // First try to use structured key_points if available
            if (article.key_points && Array.isArray(article.key_points) && article.key_points.length > 0) {
              parsedContent.keyPoints = article.key_points;
            }
            
            // Parse the summary field
            if (article.summary) {
              const parsed = parseContent(article.summary);
              parsedContent.summary = parsed.summary || parsedContent.summary;
              if (parsed.keyPoints.length > 0 && parsedContent.keyPoints.length === 0) {
                parsedContent.keyPoints = parsed.keyPoints;
              }
            }
            
            return (
              <div className="space-y-6">
                {/* Summary paragraph */}
                {parsedContent.summary && (
                  <div className="bg-blue-50 rounded-lg p-6 border-l-4 border-blue-400">
                    <h3 className="font-semibold text-gray-900 mb-3">Summary</h3>
                    <div className="prose prose-lg max-w-none">
                      <p className="text-gray-800 leading-relaxed text-lg">
                        {parsedContent.summary}
                      </p>
                    </div>
                  </div>
                )}
                
                {/* Key Points as bullet list */}
                {parsedContent.keyPoints.length > 0 && (
                  <div className="bg-green-50 rounded-lg p-6 border-l-4 border-green-400">
                    <h3 className="font-semibold text-gray-900 mb-3">Key Points</h3>
                    <ul className="space-y-2">
                      {parsedContent.keyPoints.map((point, index) => (
                        <li key={index} className="flex items-start">
                          <span className="text-green-600 mr-2 mt-1">•</span>
                          <span className="text-gray-800 leading-relaxed">{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {/* Fallback if no structured content */}
                {!parsedContent.summary && parsedContent.keyPoints.length === 0 && (
                  <div className="bg-gray-50 rounded-lg p-6 border-l-4 border-gray-400">
                    <div className="prose prose-lg max-w-none">
                      <p className="text-gray-800 leading-relaxed text-lg">
                        {article.summary || 'No summary available'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t">
          <Button
            onClick={() => window.open(article.originalurl, '_blank')}
            className="flex items-center gap-2 text-black"
          >
            <ExternalLink className="h-4 w-4" />
            Read Original Article
          </Button>
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
        </div>
      </article>
    </div>
  )
}