[filename, config] = System.argv()
{:ok, _} = Application.ensure_all_started(:credo)
source = File.read!(filename)
sha256 = :crypto.hash(:sha256, source) |> Base.encode16(case: :lower)

result =
  case Code.string_to_quoted(source, columns: true) do
    {:error, _} ->
      %{status: "invalid-syntax", contentSha256: sha256, diagnostics: nil}

    {:ok, _ast} ->
      exec =
        Credo.run([
          "--strict",
          "--format",
          "json",
          "--no-color",
          "--config-file",
          config,
          filename
        ])

      files = Credo.Execution.get_source_files(exec)
      issues = Credo.Execution.get_issues(exec)

      unless length(files) == 1 and not exec.halted and exec.requires == [] and exec.plugins == [] do
        raise "Native Credo scope mismatch: #{inspect({length(files), exec.halted})}"
      end

      %{
        status: "checked",
        contentSha256: sha256,
        diagnostics: length(issues),
        nativeExitStatus: Credo.Execution.get_exit_status(exec),
        checks: Enum.map(issues, &to_string(&1.check)) |> Enum.sort(),
        checkedFiles: length(files),
        strict: exec.strict,
        elixir: System.version(),
        otp: System.otp_release(),
        credo: Credo.version()
      }
  end

IO.puts("CAO_CREDO_RESULT=" <> Jason.encode!(result))
