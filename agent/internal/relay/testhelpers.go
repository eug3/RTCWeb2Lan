package relay

import "fmt"

// RouteSpec is a convenience input for building route tables in tests.
type RouteSpec struct {
	Kind   string
	Host   string
	Prefix string
	Target string
}

// NewTableForTest builds a table from RouteSpecs. Exported for tests only.
func NewTableForTest(specs []RouteSpec, insecure bool) (*RouteTable, error) {
	var t RouteTable
	for i, s := range specs {
		parsed, err := ParseTarget(s.Target, false, false)
		if err != nil {
			return nil, err
		}
		parsed.InsecureTLS = insecure
		kind := s.Kind
		if kind == "" {
			kind = "host"
		}
		prefix := s.Prefix
		if kind == "prefix" && prefix == "" {
			prefix = "/"
		}
		t.Routes = append(t.Routes, Route{
			Name:   fmt.Sprintf("r%d", i),
			Kind:   kind,
			Host:   s.Host,
			Prefix: prefix,
			Target: s.Target,
			parsed: parsed,
		})
	}
	return &t, nil
}
