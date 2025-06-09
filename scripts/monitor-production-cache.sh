#!/bin/bash

# Monitor Discogs MCP Production Cache Performance
# Usage: ./monitor-production-cache.sh

echo "🔍 Discogs MCP Production Cache Monitor"
echo "======================================="

NAMESPACE_ID="e45edcc5347e4b409169c1d0a9b2ed5d"

# Check total cache entries
TOTAL_KEYS=$(wrangler kv key list --namespace-id $NAMESPACE_ID | jq length)
echo "📊 Total cache entries: $TOTAL_KEYS"

if [ "$TOTAL_KEYS" -eq 0 ]; then
    echo ""
    echo "💡 Cache is empty - this is normal for a fresh deployment"
    echo "💡 Cache will populate when users authenticate and use the system"
    echo ""
    echo "🎯 Expected cache entries after user activity:"
    echo "   • cache:collections:username:page:sort"
    echo "   • cache:searches:username:query:page" 
    echo "   • cache:releases:123456"
    echo "   • cache:stats:username"
    echo "   • cache:userProfiles:token"
    echo ""
    echo "🔧 To trigger caching:"
    echo "   1. Visit: https://discogs-mcp-prod.rian-db8.workers.dev/login"
    echo "   2. Use MCP tools: search_collection, get_release, get_collection_stats"
    echo "   3. Re-run this script to see cache population"
else
    # Break down by cache type
    echo ""
    echo "📂 Cache breakdown:"
    wrangler kv key list --namespace-id $NAMESPACE_ID | jq -r '.[] | .name' | while read key; do
      if [[ $key == cache:collections:* ]]; then
        echo "  Collections: +1"
      elif [[ $key == cache:releases:* ]]; then
        echo "  Releases: +1"
      elif [[ $key == cache:searches:* ]]; then
        echo "  Searches: +1"
      elif [[ $key == cache:stats:* ]]; then
        echo "  Stats: +1"
      elif [[ $key == cache:userProfiles:* ]]; then
        echo "  User Profiles: +1"
      fi
    done | sort | uniq -c

    echo ""
    echo "🕒 Recent cache entries:"
    wrangler kv key list --namespace-id $NAMESPACE_ID | jq -r '.[] | .name' | head -10

    echo ""
    echo "🎯 Cache performance indicators:"
    COLLECTIONS=$(wrangler kv key list --namespace-id $NAMESPACE_ID | jq -r '.[] | .name' | grep -c "cache:collections:" || echo "0")
    SEARCHES=$(wrangler kv key list --namespace-id $NAMESPACE_ID | jq -r '.[] | .name' | grep -c "cache:searches:" || echo "0")
    RELEASES=$(wrangler kv key list --namespace-id $NAMESPACE_ID | jq -r '.[] | .name' | grep -c "cache:releases:" || echo "0")
    
    echo "   • Collection browses cached: $COLLECTIONS"
    echo "   • Search queries cached: $SEARCHES"  
    echo "   • Release details cached: $RELEASES"
    
    if [ "$SEARCHES" -gt 0 ] && [ "$RELEASES" -gt 0 ]; then
        echo "   🎉 Smart caching is working optimally!"
    fi
fi

echo ""
echo "💡 Monitor with: ./monitor-production-cache.sh"
echo "💡 Inspect entry: wrangler kv key get '<key>' --namespace-id $NAMESPACE_ID" 