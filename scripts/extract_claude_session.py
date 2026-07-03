import os
import json
import sys
from datetime import datetime

CLAUDE_DIR = os.path.expandvars(r'%USERPROFILE%\.claude\projects')

def get_project_dirs():
    if not os.path.exists(CLAUDE_DIR):
        print(f"Error: Claude projects directory not found at: {CLAUDE_DIR}")
        return []
    
    projects = []
    for entry in os.scandir(CLAUDE_DIR):
        if entry.is_dir() and entry.name != 'memory':
            projects.append(entry)
    return sorted(projects, key=lambda e: e.stat().st_mtime, reverse=True)

def list_sessions(limit_per_project=5):
    project_dirs = get_project_dirs()
    if not project_dirs:
        print("No Claude projects found.")
        return

    print("Available Claude Projects and Recent Sessions:\n")
    for i, proj in enumerate(project_dirs, start=1):
        print(f"{i}. Project: {proj.name}")
        
        # Get all session files in this project
        sessions = []
        for entry in os.scandir(proj.path):
            if entry.is_file() and entry.name.endswith('.jsonl'):
                sessions.append(entry)
        
        # Sort sessions by modification time
        sessions = sorted(sessions, key=lambda e: e.stat().st_mtime, reverse=True)
        
        for sess in sessions[:limit_per_project]:
            mtime = datetime.fromtimestamp(sess.stat().st_mtime).strftime('%Y-%m-%d %H:%M:%S')
            size_kb = sess.stat().st_size / 1024
            
            # Read first line to get ai-title or first prompt if possible
            title = "Untitled Session"
            try:
                with open(sess.path, 'r', encoding='utf-8') as f:
                    for line in f:
                        data = json.loads(line)
                        if data.get('type') == 'ai-title' and data.get('aiTitle'):
                            title = data['aiTitle']
                            break
                        elif data.get('type') == 'queue-operation' and data.get('content'):
                            # fallback to first user prompt
                            prompt = data['content']
                            title = prompt[:50] + '...' if len(prompt) > 50 else prompt
                            break
            except Exception:
                pass
            
            session_id = sess.name[:-6] # strip .jsonl
            print(f"   - [{mtime}] ID: {session_id}")
            print(f"     Title: {title}")
            print(f"     Size:  {size_kb:.1f} KB")
        print()

def format_session(session_id, output_path=None):
    project_dirs = get_project_dirs()
    target_sess = None
    target_proj_name = None
    
    # Locate the session file
    for proj in project_dirs:
        sess_path = os.path.join(proj.path, f"{session_id}.jsonl")
        if os.path.exists(sess_path):
            target_sess = sess_path
            target_proj_name = proj.name
            break
            
    if not target_sess:
        print(f"Error: Session with ID '{session_id}' not found.")
        return False
        
    print(f"Extracting session {session_id} from project '{target_proj_name}'...")
    
    lines = []
    with open(target_sess, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                try:
                    lines.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    # Extract session title
    title = "Claude Session History"
    for item in lines:
        if item.get('type') == 'ai-title' and item.get('aiTitle'):
            title = item['aiTitle']
            break

    markdown_content = []
    markdown_content.append(f"# Claude Session: {title}")
    markdown_content.append(f"**Session ID:** `{session_id}`  ")
    markdown_content.append(f"**Project:** `{target_proj_name}`  \n")
    markdown_content.append("---")
    
    for item in lines:
        itype = item.get('type')
        timestamp = item.get('timestamp', '')
        time_str = ""
        if timestamp:
            try:
                time_str = f" *({datetime.fromisoformat(timestamp.replace('Z', '+00:00')).strftime('%Y-%m-%d %H:%M:%S')})*"
            except Exception:
                time_str = f" *({timestamp})*"

        if itype == 'user':
            msg = item.get('message', {})
            content = msg.get('content', '')
            
            if isinstance(content, str):
                markdown_content.append(f"\n### 👤 User{time_str}\n\n{content}\n")
            elif isinstance(content, list):
                # Handles complex list structure (e.g. tool results, text parts)
                user_parts = []
                for part in content:
                    part_type = part.get('type')
                    if part_type == 'text':
                        user_parts.append(part.get('text', ''))
                    elif part_type == 'tool_result':
                        tool_id = part.get('tool_use_id', 'unknown')
                        is_error = part.get('is_error', False)
                        result_content = part.get('content', '')
                        status_str = "❌ Error" if is_error else "✅ Success"
                        user_parts.append(f"**Tool Result ({status_str} - ID: `{tool_id}`):**\n```\n{result_content}\n```")
                
                if user_parts:
                    markdown_content.append(f"\n### 👤 User{time_str}\n\n" + "\n\n".join(user_parts) + "\n")

        elif itype == 'assistant':
            msg = item.get('message', {})
            content = msg.get('content', [])
            
            assistant_parts = []
            if isinstance(content, list):
                for part in content:
                    part_type = part.get('type')
                    if part_type == 'thinking':
                        thinking_text = part.get('thinking', '')
                        assistant_parts.append(f"<details>\n<summary>💭 Thinking Process</summary>\n\n{thinking_text}\n</details>")
                    elif part_type == 'text':
                        assistant_parts.append(part.get('text', ''))
                    elif part_type == 'tool_use':
                        tool_id = part.get('id', '')
                        tool_name = part.get('name', '')
                        tool_input = part.get('input', {})
                        try:
                            formatted_input = json.dumps(tool_input, indent=2)
                        except Exception:
                            formatted_input = str(tool_input)
                        assistant_parts.append(f"**🛠️ Tool Call:** `{tool_name}` (ID: `{tool_id}`)\n```json\n{formatted_input}\n```")
            elif isinstance(content, str):
                assistant_parts.append(content)
                
            if assistant_parts:
                markdown_content.append(f"\n### 🤖 Claude{time_str}\n\n" + "\n\n".join(assistant_parts) + "\n")
                
        elif itype == 'queue-operation' and item.get('operation') == 'enqueue' and not any(l.get('type') == 'user' for l in lines):
            # Fallback for initial prompt if no user prompt entry was created
            init_content = item.get('content', '')
            if init_content:
                markdown_content.append(f"\n### 👤 User (Initial Prompt){time_str}\n\n{init_content}\n")
                
    if not output_path:
        # Default to saving in current workspace directory
        output_filename = f"claude_session_{session_id}.md"
        output_path = os.path.abspath(output_filename)
        
    with open(output_path, 'w', encoding='utf-8') as out_f:
        out_f.write("\n".join(markdown_content))
        
    print(f"Successfully extracted session to: {output_path}")
    return output_path

if __name__ == '__main__':
    if len(sys.argv) < 2:
        list_sessions()
        print("Usage:")
        print("  python scripts/extract_claude_session.py <session_id>")
        print("  python scripts/extract_claude_session.py <session_id> <output_markdown_path>")
    else:
        sess_id = sys.argv[1]
        out_path = sys.argv[2] if len(sys.argv) > 2 else None
        format_session(sess_id, out_path)
