# Login shells may reset Docker's PATH before loading /etc/profile.d.
case ":$PATH:" in
  *":/opt/mise/shims:"*) ;;
  *) export PATH="/opt/mise/shims:$PATH" ;;
esac

# Interactive Bash follows project versions and sets JAVA_HOME for build tools.
if [ -n "${BASH_VERSION:-}" ] && [[ $- == *i* ]]; then
  eval "$(/usr/local/bin/mise activate bash)"
fi
